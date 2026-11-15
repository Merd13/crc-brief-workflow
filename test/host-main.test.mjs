import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleMessage, HOST_VERSION } from "../host/main.mjs";
import { HostError } from "../host/checkout.mjs";
import { createDecoder, encodeMessage } from "../host/protocol.mjs";

const mainPath = fileURLToPath(new URL("../host/main.mjs", import.meta.url));

function harness(overrides = {}) {
  const sent = [];
  const context = {
    send: (message) => sent.push(message),
    claudePath: "/opt/bin/claude",
    run: async () => "2.1.322 (Claude Code)\n",
    generate: async () => assert.fail("generate was not expected"),
    state: {},
    ...overrides,
  };
  return { sent, context };
}

test("ping reports the helper, node and Claude Code", async () => {
  const calls = [];
  const { sent, context } = harness({ run: async (command, args) => (calls.push([command, args]), "2.1.322 (Claude Code)\n") });
  await handleMessage({ id: 1, type: "ping" }, context);
  assert.deepEqual(sent, [
    {
      id: 1,
      ok: true,
      value: { hostVersion: HOST_VERSION, node: process.version, claude: { path: "/opt/bin/claude", version: "2.1.322 (Claude Code)" } },
    },
  ]);
  assert.deepEqual(calls, [["/opt/bin/claude", ["--version"]]]);
});

test("ping says when Claude Code cannot be started", async () => {
  const { sent, context } = harness({ run: async () => Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })) });
  await handleMessage({ id: "a", type: "ping" }, context);
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].value.claude.version, null);
  assert.match(sent[0].value.claude.error, /Could not start Claude Code at \/opt\/bin\/claude/);
});

test("an unknown request type is refused", async () => {
  const { sent, context } = harness();
  await handleMessage({ id: 2, type: "exec", command: "rm -rf /" }, context);
  assert.deepEqual(sent, [{ id: 2, ok: false, error: { code: "invalid", message: "Unknown request type." } }]);
});

test("a message that is not a request is refused", async () => {
  for (const message of [null, 7, "ping", [], { type: "ping" }, { id: {}, type: "ping" }]) {
    const { sent, context } = harness();
    await handleMessage(message, context);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ok, false);
    assert.equal(sent[0].error.code, "invalid");
  }
});

test("generate forwards progress and then the result, without the brief object", async () => {
  const { sent, context } = harness({
    generate: async ({ pr, token, model, onProgress, signal }) => {
      assert.deepEqual(pr, { org: "acme", repo: "payments", number: 7 });
      assert.equal(token, "t0ken");
      assert.equal(model, undefined);
      assert.ok(signal instanceof AbortSignal);
      onProgress("reading_pr");
      onProgress("analyzing");
      return { body: "BODY", compact: false, headSha: "abc", brief: { items: [1, 2, 3] }, stats: { seconds: 5, turns: 2, costUsd: 0.1 } };
    },
  });
  await handleMessage({ id: 3, type: "generate", pr: { org: "acme", repo: "payments", number: 7 }, token: "t0ken" }, context);
  assert.deepEqual(sent, [
    { id: 3, type: "progress", stage: "reading_pr" },
    { id: 3, type: "progress", stage: "analyzing" },
    { id: 3, ok: true, value: { body: "BODY", compact: false, headSha: "abc", items: 3, stats: { seconds: 5, turns: 2, costUsd: 0.1 } } },
  ]);
});

test("a helper error keeps its code and message", async () => {
  const { sent, context } = harness({ generate: async () => Promise.reject(new HostError("claude_failed", "Claude Code did not finish: Not logged in")) });
  await handleMessage({ id: 4, type: "generate", pr: {}, token: "t" }, context);
  assert.deepEqual(sent, [{ id: 4, ok: false, error: { code: "claude_failed", message: "Claude Code did not finish: Not logged in" } }]);
});

test("an unexpected error is reported without its details", async () => {
  const logged = [];
  const { sent, context } = harness({
    generate: async () => Promise.reject(new Error("secret path /Users/x and t0ken")),
    logError: (error) => logged.push(error.message),
  });
  await handleMessage({ id: 5, type: "generate", pr: {}, token: "t0ken" }, context);
  assert.deepEqual(sent, [{ id: 5, ok: false, error: { code: "unknown", message: "The local helper failed unexpectedly." } }]);
  assert.deepEqual(logged, ["secret path /Users/x and t0ken"]);
});

test("a second generate while one runs is refused", async () => {
  let release;
  const { sent, context } = harness({
    generate: () => new Promise((resolve) => (release = () => resolve({ body: "B", compact: false, headSha: "h", brief: { items: [] }, stats: {} }))),
  });
  const first = handleMessage({ id: 6, type: "generate", pr: {}, token: "t" }, context);
  await handleMessage({ id: 7, type: "generate", pr: {}, token: "t" }, context);
  assert.deepEqual(sent, [{ id: 7, ok: false, error: { code: "busy", message: "The local helper is already writing a brief." } }]);
  release();
  await first;
  assert.equal(sent[1].id, 6);
  assert.equal(sent[1].ok, true);
});

/** Starts the real helper and talks to it over its stdin and stdout. */
function startHelper(args) {
  const child = spawn(process.execPath, [mainPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiting = [];
  const feed = createDecoder(
    (message) => (waiting.length ? waiting.shift()(message) : messages.push(message)),
    () => {},
  );
  child.stdout.on("data", feed);
  const next = () => (messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiting.push(resolve)));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, next, exited };
}

test("the real helper answers a framed ping and exits when its input closes", async () => {
  const { child, next, exited } = startHelper(["--claude", "/nonexistent/claude"]);
  child.stdin.write(encodeMessage({ id: 1, type: "ping" }));
  const reply = await next();
  assert.equal(reply.id, 1);
  assert.equal(reply.ok, true);
  assert.equal(reply.value.hostVersion, HOST_VERSION);
  assert.equal(reply.value.claude.version, null);
  child.stdin.write(encodeMessage({ id: 2, type: "nope" }));
  assert.equal((await next()).error.code, "invalid");
  child.stdin.end();
  assert.equal(await exited, 0);
});

test("the real helper refuses to start without the path of Claude Code", async () => {
  const { exited } = startHelper([]);
  assert.equal(await exited, 2);
});

test("a very long error message is cut, so the answer always fits in one message", async () => {
  const { sent, context } = harness({ generate: async () => Promise.reject(new HostError("invalid_brief", "x".repeat(50000))) });
  await handleMessage({ id: 8, type: "generate", pr: {}, token: "t" }, context);
  assert.equal(sent[0].error.code, "invalid_brief");
  assert.ok(sent[0].error.message.length <= 4001);
  assert.ok(sent[0].error.message.endsWith("…"));
});

test("the real helper refuses a relative path for Claude Code", async () => {
  // A relative path would be looked up inside the pull request's checkout.
  const { exited } = startHelper(["--claude", "bin/claude"]);
  assert.equal(await exited, 2);
});
