import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh copy of the contract's example brief. */
export function exampleBrief() {
  return JSON.parse(readFileSync(new URL("./fixtures/example-brief.json", import.meta.url), "utf8"));
}

/** The parts of the example brief that Claude Code returns. */
export function exampleGeneration() {
  const { context, readingPath, items } = exampleBrief();
  return { context, readingPath, items };
}

export const examplePr = Object.freeze({ ...exampleBrief().pr });
export const runUrl = "https://github.com/acme/payments/actions/runs/1";
export const now = "2026-11-14T10:00:00.000Z";

/** Runs git with a fixed identity and no signing, and returns its trimmed output. */
export const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/**
 * A bare "remote" with a base commit on main and a pull request head at refs/pull/7/head.
 * The head changes a.txt, adds the file the example brief refers to, and adds a link that leaves the repository.
 */
export function remoteWithPull() {
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
  mkdirSync(join(work, "src/billing"), { recursive: true });
  writeFileSync(join(work, "src/billing/retry-payment.ts"), "line\n".repeat(100));
  symlinkSync("/etc", join(work, "outside-link"));
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Change");
  const headSha = git(work, "rev-parse", "HEAD");
  const remote = join(root, "remote.git");
  git(root, "clone", "-q", "--bare", work, remote);
  git(remote, "update-ref", "refs/pull/7/head", headSha);
  return { root, remote, baseSha, headSha };
}
