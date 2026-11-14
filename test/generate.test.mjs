import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, generate } from "../host/generate.mjs";
import { HostError } from "../host/checkout.mjs";
import { localClaudeArgs } from "../lib/claude-args.mjs";
import { runCommand } from "../lib/inputs.mjs";
import { extractBrief } from "../lib/render.mjs";
import { parseBriefFile } from "../contract/contract.mjs";
import { exampleGeneration, now, remoteWithPull } from "./helpers.mjs";

const home = fileURLToPath(new URL("..", import.meta.url));

/** Everything a run needs, with GitHub and Claude Code replaced by fakes. */
function setup({ claude } = {}) {
  const { root, remote, baseSha, headSha } = remoteWithPull();
  const pull = {
    number: 7,
    html_url: "https://github.com/acme/payments/pull/7",
    title: "Change",
    body: "Body",
    user: { login: "octocat" },
    base: { ref: "main", sha: baseSha },
    head: { ref: "feature", sha: headSha, repo: { full_name: "acme/payments" } },
  };
  const fetch = async (url) => {
    if (url.endsWith("/repos/acme/payments/pulls/7")) return new Response(JSON.stringify(pull), { status: 200 });
    if (url.includes("/pulls/7/commits")) return new Response(JSON.stringify([{ sha: headSha, commit: { message: "Change" } }]), { status: 200 });
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  const run = (command, args, options) =>
    runCommand(command, args.map((arg) => (arg === "https://github.com/acme/payments.git" ? remote : arg)), options);
  const claudeCalls = [];
  const defaultClaude = async () => ({
    code: 0,
    stdout: JSON.stringify({ is_error: false, num_turns: 4, total_cost_usd: 0.25, structured_output: exampleGeneration() }),
    stderr: "",
  });
  const runClaude = async (call) => {
    claudeCalls.push({
      ...call,
      sawDiff: existsSync(join(call.cwd, ".crc-brief/diff.patch")) && readFileSync(join(call.cwd, ".crc-brief/diff.patch"), "utf8").includes("+two"),
      sawLink: existsSync(join(call.cwd, "outside-link")),
    });
    return (claude ?? defaultClaude)(call);
  };
  const deps = { fetch, run, runClaude, cacheDir: join(root, "cache"), home, now: () => now };
  return { root, deps, claudeCalls, headSha, baseSha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const request = { pr: { org: "acme", repo: "payments", number: 7 }, token: "t0ken" };
const hostError = (code, pattern) => (error) =>
  error instanceof HostError && error.code === code && (!pattern || pattern.test(error.message));

test("a run returns a comment that carries a valid brief for the pull request head", async () => {
  const { deps, claudeCalls, headSha, cleanup } = setup();
  try {
    const stages = [];
    const result = await generate({ ...request, deps, onProgress: (stage) => stages.push(stage) });

    assert.deepEqual(stages, ["reading_pr", "fetching_code", "analyzing", "validating"]);
    const brief = extractBrief(result.body);
    assert.equal(parseBriefFile(brief).ok, true);
    assert.equal(brief.pr.headSha, headSha);
    assert.equal(result.headSha, headSha);
    assert.equal(brief.meta.model, DEFAULT_MODEL);
    assert.equal(brief.meta.source, "generated");
    assert.equal(brief.items[0].sourceRefs.length, 1, "anchors on real lines are kept");
    assert.ok(result.body.includes("Generated locally by Code Review Companion"));
    assert.equal(result.compact, false);
    assert.equal(result.stats.turns, 4);
    assert.equal(result.stats.costUsd, 0.25);
    assert.equal(typeof result.stats.seconds, "number");

    // Claude Code ran once, in the checkout, with the fixed arguments, and saw the diff but not the outside link.
    assert.equal(claudeCalls.length, 1);
    const call = claudeCalls[0];
    assert.ok(call.cwd.startsWith(join(deps.cacheDir, "runs")));
    const schema = readFileSync(join(home, "contract/generation.schema.json"), "utf8").trim();
    assert.deepEqual(call.args, localClaudeArgs({ model: DEFAULT_MODEL, schema, prompt: call.args[1] }));
    assert.ok(call.args[1].includes("#7") && call.args[1].includes("acme/payments") && call.args[1].includes(headSha));
    assert.equal(call.sawDiff, true);
    assert.equal(call.sawLink, false);
    // The temporary checkout is gone.
    assert.equal(existsSync(call.cwd), false);
  } finally {
    cleanup();
  }
});

test("an anchor on the helper's own input files is removed", async () => {
  const output = exampleGeneration();
  output.items[0].sourceRefs = [{ path: ".crc-brief/pr.json", startLine: 1, endLine: 1 }];
  const { deps, cleanup } = setup({
    claude: async () => ({ code: 0, stdout: JSON.stringify({ is_error: false, structured_output: output }), stderr: "" }),
  });
  try {
    const result = await generate({ ...request, deps });
    assert.deepEqual(result.brief.items[0].sourceRefs, []);
    assert.equal(result.brief.meta.droppedAnchors[0].path, ".crc-brief/pr.json");
  } finally {
    cleanup();
  }
});

test("the caller's model is used", async () => {
  const { deps, claudeCalls, cleanup } = setup();
  try {
    const result = await generate({ ...request, model: "claude-sonnet-5-5", deps });
    assert.equal(claudeCalls[0].args[claudeCalls[0].args.indexOf("--model") + 1], "claude-sonnet-5-5");
    assert.equal(result.brief.meta.model, "claude-sonnet-5-5");
  } finally {
    cleanup();
  }
});

test("a bad request runs nothing", async () => {
  const { deps, claudeCalls, cleanup } = setup();
  try {
    let commands = 0;
    const counted = { ...deps, run: (...args) => (commands++, deps.run(...args)), fetch: () => assert.fail("no request expected") };
    await assert.rejects(generate({ pr: { org: "acme", repo: "../x", number: 7 }, token: "t", deps: counted }), hostError("invalid"));
    await assert.rejects(generate({ pr: request.pr, token: "", deps: counted }), hostError("invalid", /GitHub token/));
    await assert.rejects(generate({ ...request, model: "m; rm -rf /", deps: counted }), hostError("invalid", /model/));
    await assert.rejects(generate({ ...request, model: "--dangerously-skip-permissions", deps: counted }), hostError("invalid", /model/));
    assert.equal(commands, 0);
    assert.equal(claudeCalls.length, 0);
  } finally {
    cleanup();
  }
});

test("an unknown pull request is not_found", async () => {
  const { deps, cleanup } = setup();
  try {
    await assert.rejects(
      generate({ pr: { org: "acme", repo: "payments", number: 99 }, token: "t", deps }),
      hostError("not_found", /Pull request #99 was not found/),
    );
  } finally {
    cleanup();
  }
});

test("Claude Code's own failure text reaches the user", async () => {
  const { deps, claudeCalls, cleanup } = setup({
    claude: async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }), stderr: "" }),
  });
  try {
    await assert.rejects(generate({ ...request, deps }), hostError("claude_failed", /Not logged in · Please run \/login/));
    assert.equal(existsSync(claudeCalls[0].cwd), false, "the checkout is removed after a failure too");
  } finally {
    cleanup();
  }
});

test("a crash without JSON reports the first line of its error output", async () => {
  const { deps, cleanup } = setup({ claude: async () => ({ code: 127, stdout: "", stderr: "claude: command not found\nmore" }) });
  try {
    await assert.rejects(generate({ ...request, deps }), hostError("claude_failed", /claude: command not found/));
  } finally {
    cleanup();
  }
});

test("output without structured output is a failure", async () => {
  const { deps, cleanup } = setup({ claude: async () => ({ code: 0, stdout: JSON.stringify({ is_error: false, result: "Here you go" }), stderr: "" }) });
  try {
    await assert.rejects(generate({ ...request, deps }), hostError("claude_failed", /no structured output/));
  } finally {
    cleanup();
  }
});

test("a brief that breaks the contract is invalid_brief with the path", async () => {
  const output = exampleGeneration();
  output.items[0].type = "decision";
  const { deps, cleanup } = setup({
    claude: async () => ({ code: 0, stdout: JSON.stringify({ is_error: false, structured_output: output }), stderr: "" }),
  });
  try {
    await assert.rejects(generate({ ...request, deps }), hostError("invalid_brief", /^items\[0\]\.type/));
  } finally {
    cleanup();
  }
});

test("stopping the run cancels it and removes the checkout", async () => {
  const controller = new AbortController();
  let cwd;
  const { deps, cleanup } = setup({
    claude: (call) =>
      new Promise((resolve) => {
        cwd = call.cwd;
        call.signal.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "" }));
        controller.abort();
      }),
  });
  try {
    await assert.rejects(generate({ ...request, deps, signal: controller.signal }), hostError("cancelled"));
    assert.equal(existsSync(cwd), false);
  } finally {
    cleanup();
  }
});

test("the token appears in no error message", async () => {
  const { deps, cleanup } = setup({ claude: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
  try {
    await assert.rejects(generate({ ...request, deps }), (error) => !error.message.includes("t0ken"));
  } finally {
    cleanup();
  }
});
