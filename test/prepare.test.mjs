import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrompt, formatOutputs, prepare, resolvePrNumber } from "../scripts/prepare.mjs";

test("pull_request event gives the PR number", () => {
  assert.equal(resolvePrNumber({ eventName: "pull_request", event: { pull_request: { number: 7 } }, input: "" }), 7);
});

test("manual run uses the input", () => {
  assert.equal(resolvePrNumber({ eventName: "workflow_dispatch", event: {}, input: " 12 " }), 12);
});

test("manual run without a number fails readably", () => {
  assert.throws(
    () => resolvePrNumber({ eventName: "workflow_dispatch", event: {}, input: "" }),
    /manual run needs the pr_number input/,
  );
});

test("a non-number input is refused", () => {
  for (const input of ["12; rm -rf", "0", "-3", "1.5", "abc", "#12"]) {
    assert.throws(
      () => resolvePrNumber({ eventName: "workflow_dispatch", event: {}, input }),
      /is not a pull request number/,
      input,
    );
  }
});

const pull = {
  number: 248,
  html_url: "https://github.com/acme/payments/pull/248",
  title: "Keep payment retries idempotent",
  body: "Fixes double charges.",
  user: { login: "octocat" },
  base: { ref: "main", sha: "1b2c3d4e5f60718293a4b5c6d7e8f90123456789" },
  head: { ref: "retry-key", sha: "8f21c9a4d3e7b0615c2a9f8e7d6b5a4938271605", repo: { full_name: "acme/payments" } },
};

function fakeGitHub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const path = url.replace("https://api.github.com", "");
    const hit = routes[path];
    if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200 });
  };
  return { fetch, calls };
}

test("prepare maps the pull request and its commits", async () => {
  const { fetch, calls } = fakeGitHub({
    "/repos/acme/payments/pulls/248": pull,
    "/repos/acme/payments/pulls/248/commits?per_page=100&page=1": [
      { sha: "aaa", commit: { message: "Reuse the key\n\nWhy: timeouts." } },
      { sha: "bbb", commit: { message: "Add tests" } },
    ],
  });
  const facts = await prepare({ repo: "acme/payments", number: 248, fetch, token: "t0ken" });
  assert.deepEqual(facts, {
    org: "acme",
    repo: "payments",
    number: 248,
    url: "https://github.com/acme/payments/pull/248",
    title: "Keep payment retries idempotent",
    body: "Fixes double charges.",
    author: "octocat",
    baseRef: "main",
    headRef: "retry-key",
    baseSha: "1b2c3d4e5f60718293a4b5c6d7e8f90123456789",
    headSha: "8f21c9a4d3e7b0615c2a9f8e7d6b5a4938271605",
    commits: [
      { sha: "aaa", message: "Reuse the key\n\nWhy: timeouts." },
      { sha: "bbb", message: "Add tests" },
    ],
  });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.headers.Authorization, "Bearer t0ken");
});

test("prepare reads every page of commits", async () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ sha: `${n}-${i}`, commit: { message: "m" } }));
  const { fetch } = fakeGitHub({
    "/repos/acme/payments/pulls/248": pull,
    "/repos/acme/payments/pulls/248/commits?per_page=100&page=1": page(1, 100),
    "/repos/acme/payments/pulls/248/commits?per_page=100&page=2": page(2, 30),
  });
  const facts = await prepare({ repo: "acme/payments", number: 248, fetch, token: "t" });
  assert.equal(facts.commits.length, 130);
});

test("a pull request without a description has an empty body", async () => {
  const { fetch } = fakeGitHub({
    "/repos/acme/payments/pulls/248": { ...pull, body: null },
    "/repos/acme/payments/pulls/248/commits?per_page=100&page=1": [],
  });
  assert.equal((await prepare({ repo: "acme/payments", number: 248, fetch, token: "t" })).body, "");
});

test("a pull request from a fork is refused", async () => {
  const { fetch } = fakeGitHub({
    "/repos/acme/payments/pulls/248": { ...pull, head: { ...pull.head, repo: { full_name: "mallory/payments" } } },
  });
  await assert.rejects(
    prepare({ repo: "acme/payments", number: 248, fetch, token: "t" }),
    /Pull request #248 comes from a fork \(mallory\/payments\)\. Briefs are written only for branches of acme\/payments\./,
  );
});

test("a pull request whose head repository was deleted is refused", async () => {
  const { fetch } = fakeGitHub({ "/repos/acme/payments/pulls/248": { ...pull, head: { ...pull.head, repo: null } } });
  await assert.rejects(prepare({ repo: "acme/payments", number: 248, fetch, token: "t" }), /comes from a fork/);
});

test("the same repository in another letter case is not a fork", async () => {
  const { fetch } = fakeGitHub({
    "/repos/acme/payments/pulls/248": { ...pull, head: { ...pull.head, repo: { full_name: "Acme/Payments" } } },
    "/repos/acme/payments/pulls/248/commits?per_page=100&page=1": [],
  });
  assert.equal((await prepare({ repo: "acme/payments", number: 248, fetch, token: "t" })).number, 248);
});

test("an unknown pull request fails readably", async () => {
  const { fetch } = fakeGitHub({});
  await assert.rejects(
    prepare({ repo: "acme/payments", number: 99, fetch, token: "t" }),
    /Pull request #99 was not found in acme\/payments\./,
  );
});

test("the prompt names the pull request and both commits", () => {
  const template = readFileSync(new URL("../prompt/brief-prompt.md", import.meta.url), "utf8");
  const prompt = buildPrompt(template, { repo: "acme/payments", number: 248, baseSha: "base123", headSha: "head456" });
  assert.ok(prompt.includes("#248"));
  assert.ok(prompt.includes("acme/payments"));
  assert.ok(prompt.includes("base123"));
  assert.ok(prompt.includes("head456"));
  for (const file of [".crc-brief/pr.json", ".crc-brief/diff.patch", ".crc-brief/commits.txt"]) assert.ok(prompt.includes(file), file);
  // Claude Code has no shell: the prompt must not send it to one.
  assert.equal(/git (diff|log|show)/.test(prompt), false);
  assert.equal(/\{\{[A-Z_]+\}\}/.test(prompt), false);
});

test("outputs use the delimiter form, so a value may span lines", () => {
  assert.equal(formatOutputs({ number: "248", prompt: "x\ny" }, "D"), "number<<D\n248\nD\nprompt<<D\nx\ny\nD\n");
});

test("an output that contains the delimiter is refused", () => {
  assert.throws(() => formatOutputs({ prompt: "a\nD\nb" }, "D"), /delimiter/);
});
