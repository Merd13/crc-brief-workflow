// The helper's own copy of a pull request's code: a cached bare repository per GitHub
// repository, and one temporary checkout per run. The reviewer's clones are never touched.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** An error the extension can show. `code` is one of the helper's error codes. */
export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

const NAME = /^[A-Za-z0-9._-]+$/;
const isName = (value) =>
  typeof value === "string" && NAME.test(value) && value !== "." && value !== ".." && !value.startsWith("-");
const isCommitId = (value) => typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value);

/**
 * Checks the pull request a request names. The names become part of a path and a URL,
 * so anything but a plain GitHub name is refused.
 * @returns {{ org: string, repo: string, number: number }}
 */
export function validatePr(pr) {
  if (typeof pr !== "object" || pr === null) throw new HostError("invalid", "The request names no pull request.");
  const { org, repo, number } = pr;
  if (!isName(org)) throw new HostError("invalid", "The organization name is not valid.");
  if (!isName(repo) || repo.toLowerCase().endsWith(".git")) throw new HostError("invalid", "The repository name is not valid.");
  if (!Number.isInteger(number) || number < 1) throw new HostError("invalid", "The pull request number is not valid.");
  return { org, repo, number };
}

/**
 * Environment that gives one git command the token, as a header for github.com only.
 * The token is in no argument (other users of the machine can see arguments) and in no file.
 */
export function gitAuthEnv(token) {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from(`x-access-token:${token}`).toString("base64"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Deletes every symbolic link under `dir` that points outside it, or nowhere.
 * Claude Code may read any path inside the checkout, and a link would lead it out.
 * @returns {string[]} the removed links, relative to `dir`
 */
export function removeEscapingSymlinks(dir) {
  const root = realpathSync(dir);
  const removed = [];
  const visit = (folder) => {
    for (const name of readdirSync(folder)) {
      if (name === ".git") continue;
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let inside = false;
        try {
          const rel = relative(root, realpathSync(path));
          inside = rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
        } catch {
          // A link to nothing.
        }
        if (!inside) {
          unlinkSync(path); // removes the link itself, never its target
          removed.push(relative(root, path).split(sep).join("/"));
        }
      } else if (stat.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(root);
  return removed;
}

/** A run takes minutes. A checkout this old belongs to a run that was killed before it could clean up. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes temporary checkouts that a stopped run left behind (for example, Chrome was killed).
 * They hold pull request code, so they must not stay on disk.
 * @param {string} cacheDir
 * @param {number} [now] milliseconds since the epoch
 * @returns {string[]} the names of the removed folders
 */
export function removeStaleRuns(cacheDir, now = Date.now()) {
  const runs = join(cacheDir, "runs");
  if (!existsSync(runs)) return [];
  const removed = [];
  for (const name of readdirSync(runs)) {
    const dir = join(runs, name);
    try {
      if (now - statSync(dir).mtimeMs > STALE_RUN_MS) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // Another helper process may be removing it at the same moment.
    }
  }
  return removed;
}

const firstLine = (text) => String(text ?? "").trim().split("\n")[0] ?? "";

/**
 * Fetches the pull request into the helper's cache and makes a temporary checkout of its head.
 * @param {{ cacheDir: string, org: string, repo: string, number: number, headSha: string, baseSha: string,
 *           token: string, run: (command: string, args: string[], options?: object) => Promise<string> }} input
 * @returns {Promise<{ dir: string, removedLinks: string[], cleanup: () => Promise<void> }>}
 */
export async function prepareCheckout({ cacheDir, org, repo, number, headSha, baseSha, token, run }) {
  validatePr({ org, repo, number });
  if (!isCommitId(headSha) || !isCommitId(baseSha)) throw new HostError("invalid", "The pull request's commit ids are not valid.");

  const bare = join(cacheDir, "repos", org, `${repo}.git`);
  if (!existsSync(bare)) {
    mkdirSync(bare, { recursive: true });
    await run("git", ["init", "--bare", "--quiet", bare]);
  }
  try {
    await run(
      "git",
      ["fetch", "--no-tags", "--quiet", `https://github.com/${org}/${repo}.git`, `+refs/pull/${number}/head:refs/crc/pull/${number}`, baseSha],
      { cwd: bare, env: gitAuthEnv(token) },
    );
  } catch (error) {
    const detail = firstLine(error.stderr).replaceAll(token, "[token]");
    throw new HostError(
      "github",
      `Could not fetch pull request #${number} of ${org}/${repo}. Check that your GitHub token can read the repository's contents.${detail ? ` (git: ${detail})` : ""}`,
    );
  }

  mkdirSync(join(cacheDir, "runs"), { recursive: true });
  const dir = join(cacheDir, "runs", randomUUID());
  try {
    await run("git", ["worktree", "add", "--detach", "--quiet", dir, headSha], { cwd: bare });
  } catch {
    // The fetch brought the pull request's newest head. If that is no longer `headSha`, somebody pushed.
    throw new HostError("github", "The pull request changed while the brief was being prepared. Try again.");
  }
  const cleanup = async () => {
    try {
      await run("git", ["worktree", "remove", "--force", dir], { cwd: bare });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], { cwd: bare }).catch(() => {});
    }
  };
  try {
    return { dir, removedLinks: removeEscapingSymlinks(dir), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
