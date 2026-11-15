import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAuthEnv, HostError, isolatedGit, prepareCheckout, removeEscapingSymlinks, removeStaleRuns, validatePr } from "../host/checkout.mjs";
import { runCommand, writeBriefInputs } from "../lib/inputs.mjs";
import { git, remoteWithPull } from "./helpers.mjs";

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
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_1, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_1, "/dev/null");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, "Authorization: Basic " + Buffer.from("x-access-token:t0ken").toString("base64"));
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

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
    assert.ok(withAuth[0].args.includes("fetch"));
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
      args.includes("fetch")
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

test("removeStaleRuns deletes checkouts that a stopped run left behind, and only those", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "crc-stale-"));
  try {
    const now = Date.parse("2026-11-14T12:00:00Z");
    const make = (name, ageHours) => {
      const dir = join(cacheDir, "runs", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "code.txt"), "pull request code\n");
      const at = new Date(now - ageHours * 3600 * 1000);
      utimesSync(dir, at, at);
      return dir;
    };
    const old = make("old", 30);
    const fresh = make("fresh", 1);
    mkdirSync(join(cacheDir, "repos", "acme", "payments.git"), { recursive: true });

    assert.deepEqual(removeStaleRuns(cacheDir, now), ["old"]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(join(cacheDir, "repos", "acme", "payments.git")), true);
    // Nothing to do, and no cache yet, are both fine.
    assert.deepEqual(removeStaleRuns(cacheDir, now), []);
    assert.deepEqual(removeStaleRuns(join(cacheDir, "missing"), now), []);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

/** Runs commands like the real runner, but with a global git configuration the test controls. */
const withGlobalConfig = (configPath, remote) => (command, args, options) =>
  runCommand(command, args.map((arg) => (arg === "https://github.com/acme/payments.git" ? remote : arg)), {
    ...options,
    // The code under test must override this for every command that touches pull request content.
    env: { GIT_CONFIG_GLOBAL: configPath, ...options?.env },
  });

test("pull request content cannot run programs from the reviewer's git configuration", async () => {
  const { root, remote, baseSha, headSha } = remoteWithPull({ attributes: "*.txt filter=evil diff=evil\n" });
  try {
    const marker = join(root, "ran");
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
    const config = join(root, "gitconfig");
    writeFileSync(
      config,
      `[filter "evil"]\n\tsmudge = sh -c 'echo smudge >> "${marker}"; cat'\n\tclean = cat\n[diff "evil"]\n\ttextconv = sh -c 'echo textconv >> "${marker}"; cat "$0"'\n[core]\n\thooksPath = ${hooks}\n`,
    );
    const run = withGlobalConfig(config, remote);
    const checkout = await prepareCheckout({ cacheDir: join(root, "cache"), org: "acme", repo: "payments", number: 7, headSha, baseSha, token: "t0ken", run });
    await writeBriefInputs({ cwd: checkout.dir, pr: { baseSha, headSha }, run: isolatedGit(run) });
    await checkout.cleanup();
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unfinished cache folder is repaired, and git never falls back to a repository around the cache", async () => {
  const { root, remote, baseSha, headSha } = remoteWithPull();
  try {
    // The cache sits inside another git repository, as it would under a home folder kept in git.
    const outer = join(root, "outer");
    mkdirSync(outer);
    git(outer, "init", "-q", "-b", "main");
    const cacheDir = join(outer, "cache");
    // A first run was killed after it made the folder and before `git init` finished.
    mkdirSync(join(cacheDir, "repos", "acme", "payments.git"), { recursive: true });
    const run = (command, args, options) =>
      runCommand(command, args.map((arg) => (arg === "https://github.com/acme/payments.git" ? remote : arg)), options);
    const checkout = await prepareCheckout({ cacheDir, org: "acme", repo: "payments", number: 7, headSha, baseSha, token: "t0ken", run });
    assert.equal(git(checkout.dir, "rev-parse", "HEAD"), headSha);
    await checkout.cleanup();
    assert.equal(git(outer, "for-each-ref"), "", "nothing was fetched into the surrounding repository");
    assert.equal(git(outer, "worktree", "list").split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit id that is not a commit id runs nothing", async () => {
  const calls = [];
  const run = async (...args) => (calls.push(args), "");
  for (const bad of ["--upload-pack=x", "abc", "", undefined]) {
    await assert.rejects(
      prepareCheckout({ cacheDir: join(tmpdir(), "crc-none"), org: "acme", repo: "payments", number: 7, headSha: "a".repeat(40), baseSha: bad, token: "t", run }),
      (error) => error instanceof HostError && error.code === "invalid",
    );
  }
  assert.equal(calls.length, 0);
});

test("the token is removed from git's own error text", async () => {
  const root = mkdtempSync(join(tmpdir(), "crc-checkout-"));
  try {
    const run = (command, args, options) =>
      args.includes("fetch")
        ? Promise.reject(Object.assign(new Error("x"), { stderr: "fatal: unable to access 'https://x-access-token:t0ken@github.com/': t0ken" }))
        : runCommand(command, args, options);
    const error = await prepareCheckout({ cacheDir: join(root, "cache"), org: "acme", repo: "payments", number: 7, headSha: "a".repeat(40), baseSha: "b".repeat(40), token: "t0ken", run }).catch((e) => e);
    assert.equal(error.code, "github");
    assert.equal(error.message.includes("t0ken"), false, error.message);
    assert.ok(error.message.includes("[token]"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the fetch gets the token, in one known variable, and it runs no hooks", async () => {
  const { root, remote, baseSha, headSha } = remoteWithPull();
  try {
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ args, env: options?.env ?? {} });
      return runCommand(command, args.map((arg) => (arg === "https://github.com/acme/payments.git" ? remote : arg)), options);
    };
    const checkout = await prepareCheckout({ cacheDir: join(root, "cache"), org: "acme", repo: "payments", number: 7, headSha, baseSha, token: "t0ken", run });
    await checkout.cleanup();
    const secret = Buffer.from("x-access-token:t0ken").toString("base64");
    const holders = calls.filter((call) => Object.values(call.env).some((value) => String(value).includes(secret) || String(value).includes("t0ken")));
    assert.equal(holders.length, 1);
    assert.ok(holders[0].args.includes("fetch"));
    assert.deepEqual(
      Object.entries(holders[0].env).filter(([, value]) => String(value).includes(secret)).map(([key]) => key),
      ["GIT_CONFIG_VALUE_0"],
    );
    // The fetch keeps the user's git configuration (a proxy may be needed) but runs no hooks from it.
    const fetchEnv = holders[0].env;
    const keys = Object.keys(fetchEnv).filter((k) => k.startsWith("GIT_CONFIG_KEY_")).map((k) => fetchEnv[k]);
    assert.ok(keys.includes("core.hooksPath"));
    // Every other command ignores the user's and the system's git configuration.
    for (const call of calls.filter((c) => !c.args.includes("fetch"))) {
      assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null", call.args.join(" "));
      assert.equal(call.env.GIT_CONFIG_NOSYSTEM, "1", call.args.join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
