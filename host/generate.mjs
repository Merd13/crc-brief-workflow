// One local run: from a pull request to the rendered brief comment.
// It uses the same prompt, schema, validation and rendering as the GitHub Action.
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceReader } from "../lib/anchors.mjs";
import { localClaudeArgs } from "../lib/claude-args.mjs";
import { INPUT_DIR, writeBriefInputs } from "../lib/inputs.mjs";
import { buildComment } from "../scripts/post.mjs";
import { buildPrompt, prepare } from "../scripts/prepare.mjs";
import { HostError, prepareCheckout, validatePr } from "./checkout.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Claude Code is stopped after this long. */
export const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

// The model name becomes a command-line argument. A leading "-" would make it an option.
const isModel = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(value);
const firstLine = (text) => String(text ?? "").trim().split("\n")[0] ?? "";
const stopIfCancelled = (signal) => {
  if (signal?.aborted) throw new HostError("cancelled", "The run was stopped.");
};

/**
 * Starts Claude Code and collects its output. It never rejects: a failure shows in `code` and `stderr`.
 * @param {string} claudePath
 * @returns {(call: { args: string[], cwd: string, signal?: AbortSignal }) => Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function claudeRunner(claudePath, timeoutMs = CLAUDE_TIMEOUT_MS) {
  return ({ args, cwd, signal }) =>
    new Promise((resolve) => {
      // stdin is closed: Claude Code otherwise waits for piped input before it starts.
      const child = spawn(claudePath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const stop = () => child.kill("SIGTERM");
      const timer = setTimeout(() => ((timedOut = true), stop()), timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const finish = (code, extra = "") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve({ code, stdout, stderr: timedOut ? `Claude Code did not finish within ${Math.round(timeoutMs / 60000)} minutes.` : stderr + extra });
      };
      child.on("error", (error) => finish(null, error.message));
      child.on("close", (code) => finish(code));
    });
}

/**
 * @param {{ pr: unknown, token: string, model?: string, signal?: AbortSignal,
 *           onProgress?: (stage: "reading_pr" | "fetching_code" | "analyzing" | "validating") => void,
 *           deps: { fetch: typeof fetch, run: Function, runClaude: Function, cacheDir: string, home: string, now: () => string } }} input
 *   `deps.home` is this repository's folder; `deps.cacheDir` holds the helper's clones.
 * @returns {Promise<{ body: string, compact: boolean, brief: any, headSha: string,
 *                     stats: { seconds: number, turns: number, costUsd: number } }>}
 * @throws {HostError}
 */
export async function generate({ pr, token, model = DEFAULT_MODEL, deps, onProgress = () => {}, signal }) {
  const { org, repo, number } = validatePr(pr);
  if (typeof token !== "string" || token.trim() === "") throw new HostError("invalid", "The request has no GitHub token.");
  if (!isModel(model)) throw new HostError("invalid", "The model name is not valid.");
  const started = Date.now();
  const fullName = `${org}/${repo}`;

  onProgress("reading_pr");
  let facts;
  try {
    facts = await prepare({ repo: fullName, number, fetch: deps.fetch, token });
  } catch (error) {
    if (error.code === "not_found") throw new HostError("not_found", error.message);
    if (error.code === "fork") throw new HostError("invalid", error.message);
    throw new HostError("github", `Could not read pull request #${number} of ${fullName} from GitHub. ${error.message}`);
  }
  stopIfCancelled(signal);

  onProgress("fetching_code");
  const checkout = await prepareCheckout({
    cacheDir: deps.cacheDir,
    org,
    repo,
    number,
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    token,
    run: deps.run,
  });
  try {
    stopIfCancelled(signal);
    await writeBriefInputs({ cwd: checkout.dir, pr: facts, run: deps.run });

    onProgress("analyzing");
    const prompt = buildPrompt(readFileSync(join(deps.home, "prompt/brief-prompt.md"), "utf8"), {
      repo: fullName,
      number,
      baseSha: facts.baseSha,
      headSha: facts.headSha,
    });
    const schema = readFileSync(join(deps.home, "contract/generation.schema.json"), "utf8").trim();
    const result = await deps.runClaude({ args: localClaudeArgs({ model, schema, prompt }), cwd: checkout.dir, signal });
    stopIfCancelled(signal);

    let output = null;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      // Claude Code stopped before it could print its result.
    }
    if (result.code !== 0 || !output || output.is_error) {
      const reason = output?.result || firstLine(result.stderr) || `exit code ${result.code}`;
      throw new HostError("claude_failed", `Claude Code did not finish: ${String(reason).replaceAll(token, "[token]")}`);
    }
    if (output.structured_output === undefined || output.structured_output === null) {
      throw new HostError("claude_failed", "Claude Code returned no structured output.");
    }

    onProgress("validating");
    // The helper's input files are not part of the pull request: a reference to them must not pass.
    rmSync(join(checkout.dir, INPUT_DIR), { recursive: true, force: true });
    const built = buildComment({
      structuredOutput: JSON.stringify(output.structured_output),
      pr: facts,
      model,
      now: deps.now(),
      readLines: workspaceReader(checkout.dir),
      runUrl: undefined,
    });
    if (!built.ok) throw new HostError("invalid_brief", built.errors.join("\n"));
    return {
      body: built.body,
      compact: built.compact,
      brief: built.brief,
      headSha: facts.headSha,
      stats: {
        seconds: Math.round((Date.now() - started) / 1000),
        turns: output.num_turns ?? 0,
        costUsd: output.total_cost_usd ?? 0,
      },
    };
  } finally {
    await checkout.cleanup();
  }
}
