import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, writeBriefInputs } from "../lib/inputs.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A repository with a base commit and a branch that adds two commits. */
function repoWithBranch() {
  const dir = mkdtempSync(join(tmpdir(), "crc-inputs-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Base");
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "commit", "-q", "-am", "Add the second line\n\nWhy: the first was lonely.");
  writeFileSync(join(dir, "b.txt"), "new file\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Add b");
  return { dir, baseSha, headSha: git(dir, "rev-parse", "HEAD") };
}

test("writes the pull request facts, the diff and the commit log", async () => {
  const { dir, baseSha, headSha } = repoWithBranch();
  try {
    const pr = { org: "acme", repo: "payments", number: 7, title: "T", body: "B", baseSha, headSha, commits: [] };
    await writeBriefInputs({ cwd: dir, pr, run: runCommand });

    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".crc-brief/pr.json"), "utf8")), pr);

    const diff = readFileSync(join(dir, ".crc-brief/diff.patch"), "utf8");
    assert.ok(diff.includes("+++ b/a.txt"));
    assert.ok(diff.includes("\n+two\n"));
    assert.ok(diff.includes("+++ b/b.txt"));

    const commits = readFileSync(join(dir, ".crc-brief/commits.txt"), "utf8");
    assert.ok(commits.includes("Why: the first was lonely."));
    assert.ok(commits.indexOf("Add the second line") < commits.indexOf("Add b"), "oldest first");
    assert.ok(commits.includes(`commit ${headSha}`));
    assert.equal(commits.includes("Base"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the diff is what the branch changed, even when the base branch moved on", async () => {
  const { dir, baseSha, headSha } = repoWithBranch();
  try {
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "c.txt"), "later on main\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "Main moves");
    const newBase = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "--detach", headSha);
    await writeBriefInputs({ cwd: dir, pr: { baseSha: newBase, headSha }, run: runCommand });
    const diff = readFileSync(join(dir, ".crc-brief/diff.patch"), "utf8");
    assert.ok(diff.includes("+++ b/b.txt"));
    assert.equal(diff.includes("c.txt"), false);
    assert.notEqual(baseSha, newBase);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit id that is not a commit id never reaches git", async () => {
  const calls = [];
  const run = async (...args) => (calls.push(args), "");
  await assert.rejects(
    writeBriefInputs({ cwd: tmpdir(), pr: { baseSha: "--output=/tmp/x", headSha: "abc123" }, run }),
    /not a commit id/,
  );
  assert.equal(calls.length, 0);
});

test("the diff never runs a text converter", async () => {
  const calls = [];
  const run = async (command, args) => (calls.push(args), "");
  const dir = mkdtempSync(join(tmpdir(), "crc-inputs-"));
  try {
    await writeBriefInputs({ cwd: dir, pr: { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, run });
    const diff = calls.find((args) => args[0] === "diff");
    assert.ok(diff.includes("--no-textconv"));
    assert.ok(diff.includes("--no-ext-diff"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .crc-brief that the pull request supplies is replaced, not followed", async () => {
  const { dir, baseSha, headSha } = repoWithBranch();
  try {
    // As a link to a folder of the repository: the inputs must not land in that folder.
    mkdirSync(join(dir, "src"));
    symlinkSync("src", join(dir, ".crc-brief"));
    await writeBriefInputs({ cwd: dir, pr: { baseSha, headSha }, run: runCommand });
    assert.equal(existsSync(join(dir, "src", "pr.json")), false);
    assert.equal(lstatSync(join(dir, ".crc-brief")).isDirectory(), true);
    assert.equal(existsSync(join(dir, ".crc-brief", "diff.patch")), true);
    // As a regular file: the run must not fail.
    rmSync(join(dir, ".crc-brief"), { recursive: true });
    writeFileSync(join(dir, ".crc-brief"), "not a folder\n");
    await writeBriefInputs({ cwd: dir, pr: { baseSha, headSha }, run: runCommand });
    assert.equal(existsSync(join(dir, ".crc-brief", "pr.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand stops a command when asked to, and after its time limit", async () => {
  const controller = new AbortController();
  const stopped = runCommand("sleep", ["30"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(stopped);
  const started = Date.now();
  await assert.rejects(runCommand("sleep", ["30"], { timeoutMs: 200 }));
  assert.ok(Date.now() - started < 5000);
});
