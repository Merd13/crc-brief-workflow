import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildComment, run } from "../scripts/post.mjs";
import { parseBriefFile } from "../contract/contract.mjs";
import { extractBrief } from "../lib/render.mjs";
import { exampleGeneration, examplePr, now, runUrl } from "./helpers.mjs";

const hundredLines = () => new Array(100).fill("");
const base = { pr: examplePr, model: "claude-opus-5-5", now, readLines: hundredLines, runUrl };
const output = (change = (g) => g) => JSON.stringify(change(exampleGeneration()));

test("a good output becomes a comment that carries a valid brief", () => {
  const r = buildComment({ ...base, structuredOutput: output() });
  assert.equal(r.ok, true, r.errors?.join("\n"));
  assert.equal(r.compact, false);
  const brief = extractBrief(r.body);
  assert.equal(parseBriefFile(brief).ok, true);
  assert.deepEqual(brief, r.brief);
  assert.equal(brief.pr.headSha, examplePr.headSha);
  assert.equal(brief.meta.source, "generated");
  assert.equal(brief.meta.model, "claude-opus-5-5");
  assert.ok(r.body.length <= 65536);
});

test("empty output posts nothing", () => {
  for (const structuredOutput of ["", "  ", undefined]) {
    assert.deepEqual(buildComment({ ...base, structuredOutput }), {
      ok: false,
      errors: ["Claude Code returned no structured output."],
    });
  }
});

test("output that is not JSON posts nothing", () => {
  assert.deepEqual(buildComment({ ...base, structuredOutput: "Here is the brief: {" }), {
    ok: false,
    errors: ["Claude Code's output is not valid JSON."],
  });
});

test("output that is not an object posts nothing", () => {
  const r = buildComment({ ...base, structuredOutput: "null" });
  assert.equal(r.ok, false);
});

test("output that breaks the contract posts nothing and names the path", () => {
  const r = buildComment({ ...base, structuredOutput: output((g) => ((g.items[0].type = "decision"), g)) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^items\[0\]\.type/);
});

test("a missing part posts nothing and names the path", () => {
  const r = buildComment({ ...base, structuredOutput: output((g) => (delete g.items, g)) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^items/);
});

test("duplicate ids post nothing", () => {
  const r = buildComment({ ...base, structuredOutput: output((g) => ((g.items[1].id = g.items[0].id), g)) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /duplicate item id/);
});

test("bad anchors are removed and recorded, the item stays", () => {
  const r = buildComment({ ...base, structuredOutput: output(), readLines: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.brief.items.length, 2);
  assert.deepEqual(r.brief.items[0].sourceRefs, []);
  assert.equal(r.brief.meta.droppedAnchors.length, 2);
  assert.equal(parseBriefFile(r.brief).ok, true);
});

test("a brief that cannot fit reports its size", () => {
  const huge = "x".repeat(70000);
  const r = buildComment({ ...base, structuredOutput: output((g) => ((g.context.approach = huge), g)) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^The brief comment is \d+ characters; GitHub allows 65536\.$/);
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "crc-post-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src/billing"), { recursive: true });
  writeFileSync(join(repo, "src/billing/retry-payment.ts"), "line\n".repeat(100));
  const prFile = join(dir, "pr.json");
  writeFileSync(prFile, JSON.stringify({ ...examplePr, body: "text", commits: [] }));
  const summary = join(dir, "summary.md");
  const env = {
    GITHUB_TOKEN: "t0ken",
    GITHUB_REPOSITORY: "acme/payments",
    GITHUB_WORKSPACE: repo,
    GITHUB_STEP_SUMMARY: summary,
    CRC_PR_FILE: prFile,
    INPUT_MODEL: "claude-opus-5-5",
    RUN_URL: runUrl,
  };
  return { dir, env, summary };
}

test("run posts one comment for a good output", async () => {
  const { dir, env, summary } = workspace();
  try {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/payments/pull/248#issuecomment-1" }), { status: 201 });
    };
    const logs = [];
    const code = await run({ env: { ...env, STRUCTURED_OUTPUT: output() }, fetch, now: () => now, log: (l) => logs.push(l) });
    assert.equal(code, 0, logs.join("\n"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.github.com/repos/acme/payments/issues/248/comments");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
    const brief = extractBrief(JSON.parse(calls[0].init.body).body);
    assert.equal(parseBriefFile(brief).ok, true);
    assert.equal(brief.items[0].sourceRefs.length, 1);
    assert.ok(logs.join("\n").includes("https://github.com/acme/payments/pull/248#issuecomment-1"));
    assert.ok(readFileSync(summary, "utf8").includes("issuecomment-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run posts nothing for an invalid output and reports each error", async () => {
  const { dir, env } = workspace();
  try {
    let called = 0;
    const fetch = async () => (called++, new Response("{}", { status: 201 }));
    const logs = [];
    const bad = output((g) => ((g.items[0].type = "decision"), g));
    const code = await run({ env: { ...env, STRUCTURED_OUTPUT: bad }, fetch, now: () => now, log: (l) => logs.push(l) });
    assert.equal(code, 1);
    assert.equal(called, 0);
    assert.ok(logs.some((l) => l.startsWith("::error::items[0].type")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run fails when GitHub refuses the comment", async () => {
  const { dir, env } = workspace();
  try {
    const fetch = async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    const logs = [];
    const code = await run({ env: { ...env, STRUCTURED_OUTPUT: output() }, fetch, now: () => now, log: (l) => logs.push(l) });
    assert.equal(code, 1);
    assert.ok(logs.some((l) => /^::error::GitHub refused the brief comment \(403\)/.test(l)), logs.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
