import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAuthEnv, HostError, prepareCheckout, removeEscapingSymlinks, validatePr } from "../host/checkout.mjs";
import { runCommand } from "../lib/inputs.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

test("validatePr accepts a normal pull request", () => {
  assert.deepEqual(validatePr({ org: "Merd13", repo: "new-flow", number: 1 }), { org: "Merd13", repo: "new-flow", number: 1 });
  assert.deepEqual(validatePr({ org: "a.b_c-d", repo: ".github", number: 12, extra: "dropped" }), {
    org: "a.b_c-d",
    repo: ".github",
    number: 12,
  });
});

test("validatePr refuses hostile names and numbers", () => {
  const bad = [
    { org: "acme", repo: "../../x", number: 1 },
    { org: "acme", repo: "a/b", number: 1 },
    { org: "acme", repo: "x.git", number: 1 },
    { org: "acme", repo: "a b", number: 1 },
    { org: "acme", repo: ".", number: 1 },
    { org: "..", repo: "x", number: 1 },
    { org: "", repo: "x", number: 1 },
    { org: "acme", repo: "-x", number: 1 },
    { org: "acme", repo: "x", number: 0 },
    { org: "acme", repo: "x", number: 1.5 },
    { org: "acme", repo: "x", number: "7" },
    { org: "acme", repo: 7, number: 1 },
    null,
    "acme/x#1",
  ];
  for (const pr of bad) {
    assert.throws(() => validatePr(pr), (error) => error instanceof HostError && error.code === "invalid", JSON.stringify(pr));
  }
});

test("the token reaches git through the environment, as a header for github.com only", () => {
  const env = gitAuthEnv("t0ken");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, "Authorization: Basic " + Buffer.from("x-access-token:t0ken").toString("base64"));
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

/** A bare "remote" with a base commit on main and a pull request head at refs/pull/7/head. */
function remoteWithPull() {
  const root = mkdtempSync(join(tmpdir(), "crc-checkout-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Base");
  const baseSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  symlinkSync("/etc", join(work, "outside-link"));
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Change");
  const headSha = git(work, "rev-parse", "HEAD");
  const remote = join(root, "remote.git");
  git(root, "clone", "-q", "--bare", work, remote);
  git(remote, "update-ref", "refs/pull/7/head", headSha);
  return { root, remote, baseSha, headSha };
}

test("prepareCheckout makes a temporary checkout of the pull request head and cleans it up", async () => {
  const { root, remote, baseSha, headSha } = remoteWithPull();
  try {
    const calls = [];
    // The real URL is github.com; the test sends the same command to a local repository.
    const run = (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      return runCommand(command, args.map((arg) => (arg === "https://github.com/acme/payments.git" ? remote : arg)), options);
    };
    const cacheDir = join(root, "cache");
    const checkout = await prepareCheckout({ cacheDir, org: "acme", repo: "payments", number: 7, headSha, baseSha, token: "t0ken", run });

    assert.ok(checkout.dir.startsWith(join(cacheDir, "runs")));
    assert.equal(readFileSync(join(checkout.dir, "a.txt"), "utf8"), "one\ntwo\n");
    assert.equal(git(checkout.dir, "rev-parse", "HEAD"), headSha);
    // The base commit is there too, so the diff can be made.
    assert.equal(git(checkout.dir, "cat-file", "-t", baseSha), "commit");
    // The link that pointed outside the checkout is gone.
    assert.equal(existsSync(join(checkout.dir, "outside-link")), false);
    assert.deepEqual(checkout.removedLinks, ["outside-link"]);

    // The token is in no argument of any command, and only the fetch got it, in its environment.
    for (const call of calls) for (const arg of call.args) assert.equal(String(arg).includes("t0ken"), false);
    const withAuth = calls.filter((call) => call.env?.GIT_CONFIG_VALUE_0);
    assert.equal(withAuth.length, 1);
    assert.equal(withAuth[0].args[0], "fetch");
    assert.ok(withAuth[0].args.includes("https://github.com/acme/payments.git"));

    await checkout.cleanup();
    assert.equal(existsSync(checkout.dir), false);
    await checkout.cleanup(); // a second call does not throw

    // The cache is reused: a second checkout works without a new clone.
    const again = await prepareCheckout({ cacheDir, org: "acme", repo: "payments", number: 7, headSha, baseSha, token: "t0ken", run });
    assert.notEqual(again.dir, checkout.dir);
    await again.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fetch failure names the repository and not the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "crc-checkout-"));
  try {
    const run = (command, args, options) =>
      args[0] === "fetch"
        ? Promise.reject(Object.assign(new Error("failed with t0ken in it"), { stderr: "fatal: repository not found" }))
        : runCommand(command, args, options);
    await assert.rejects(
      prepareCheckout({ cacheDir: join(root, "cache"), org: "acme", repo: "payments", number: 7, headSha: "a".repeat(40), baseSha: "b".repeat(40), token: "t0ken", run }),
      (error) =>
        error instanceof HostError &&
        error.code === "github" &&
        /Could not fetch pull request #7 of acme\/payments/.test(error.message) &&
        !error.message.includes("t0ken"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeEscapingSymlinks removes links that leave the folder and keeps the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "crc-links-"));
  try {
    const dir = join(root, "checkout");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(root, "secret.txt"), "secret\n");
    mkdirSync(join(root, "outside-dir"));
    writeFileSync(join(root, "outside-dir", "kept.txt"), "kept\n");
    writeFileSync(join(dir, "real.txt"), "real\n");
    symlinkSync(join(root, "secret.txt"), join(dir, "to-file"));
    symlinkSync(join(root, "outside-dir"), join(dir, "sub", "to-dir"));
    symlinkSync("../real.txt", join(dir, "sub", "inside"));
    symlinkSync("missing-target", join(dir, "broken"));
    symlinkSync(join(root, "secret.txt"), join(dir, ".git", "internal"));

    assert.deepEqual(removeEscapingSymlinks(dir).sort(), ["broken", "sub/to-dir", "to-file"]);

    assert.equal(existsSync(join(dir, "to-file")), false);
    assert.equal(lstatSync(join(dir, "sub", "inside")).isSymbolicLink(), true);
    // Targets are never deleted, and .git is left alone.
    assert.equal(readFileSync(join(root, "secret.txt"), "utf8"), "secret\n");
    assert.equal(readFileSync(join(root, "outside-dir", "kept.txt"), "utf8"), "kept\n");
    assert.equal(lstatSync(join(dir, ".git", "internal")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
