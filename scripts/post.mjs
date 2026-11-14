// Step: turn Claude Code's output into a brief, validate it, and post the brief comment.
// Nothing is posted unless the brief passes the contract and fits in a comment.
import { appendFileSync, readFileSync } from "node:fs";
import { parseBriefFile } from "../contract/contract.mjs";
import { errorLine, githubHeaders, isMain } from "../lib/actions.mjs";
import { checkAnchors, workspaceReader } from "../lib/anchors.mjs";
import { assembleBrief } from "../lib/assemble.mjs";
import { BriefTooLargeError, renderComment } from "../lib/render.mjs";

/**
 * @param {{ structuredOutput?: string, pr: any, model: string, now: string,
 *           readLines: (path: string) => string[] | null, runUrl: string }} input
 * @returns {{ ok: true, body: string, brief: any, compact: boolean } | { ok: false, errors: string[] }}
 */
export function buildComment({ structuredOutput, pr, model, now, readLines, runUrl }) {
  if (typeof structuredOutput !== "string" || structuredOutput.trim() === "") {
    return { ok: false, errors: ["Claude Code returned no structured output."] };
  }
  let generation;
  try {
    generation = JSON.parse(structuredOutput);
  } catch {
    return { ok: false, errors: ["Claude Code's output is not valid JSON."] };
  }
  const assembled = assembleBrief({ generation, pr, model, now });
  // The shape check comes first: the anchor check reads fields that it guarantees.
  const shape = parseBriefFile(assembled);
  if (!shape.ok) return { ok: false, errors: shape.errors };
  const checked = parseBriefFile(checkAnchors(shape.brief, readLines));
  if (!checked.ok) return { ok: false, errors: checked.errors };
  try {
    const { body, compact } = renderComment(checked.brief, { runUrl });
    return { ok: true, body, brief: checked.brief, compact };
  } catch (error) {
    if (error instanceof BriefTooLargeError) return { ok: false, errors: [error.message] };
    throw error;
  }
}

/**
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch, now: () => string, log: (line: string) => void }} deps
 * @returns {Promise<number>} the process exit code
 */
export async function run({ env, fetch, now, log }) {
  const pr = JSON.parse(readFileSync(env.CRC_PR_FILE, "utf8"));
  const result = buildComment({
    structuredOutput: env.STRUCTURED_OUTPUT,
    pr,
    model: env.INPUT_MODEL,
    now: now(),
    readLines: workspaceReader(env.GITHUB_WORKSPACE),
    runUrl: env.RUN_URL,
  });
  if (!result.ok) {
    for (const error of result.errors) log(errorLine(error));
    log("No brief comment was posted.");
    return 1;
  }
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${apiUrl}/repos/${env.GITHUB_REPOSITORY}/issues/${pr.number}/comments`, {
    method: "POST",
    headers: { ...githubHeaders(env.GITHUB_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({ body: result.body }),
  });
  if (!response.ok) {
    const detail = await response.json().then((json) => json?.message, () => undefined);
    log(errorLine(`GitHub refused the brief comment (${response.status})${detail ? `: ${detail}` : ""}.`));
    return 1;
  }
  const { html_url: url } = await response.json();
  const { brief } = result;
  const dropped = brief.meta.droppedAnchors?.length ?? 0;
  const lines = [
    `Brief comment: ${url}`,
    `Size: ${result.body.length} of 65536 characters${result.compact ? " (compact form)" : ""}`,
    `Items: ${brief.items.length} (${brief.items.filter((i) => i.type === "check").length} checks, ${brief.items.filter((i) => i.type === "learning").length} learnings)`,
    `Code references removed: ${dropped}`,
  ];
  for (const line of lines) log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.map((line) => `- ${line}`).join("\n") + "\n");
  return 0;
}

if (isMain(import.meta.url)) {
  run({ env: process.env, fetch, now: () => new Date().toISOString(), log: console.log }).then(
    (code) => process.exit(code),
    (error) => {
      console.log(errorLine(error.message));
      process.exit(1);
    },
  );
}
