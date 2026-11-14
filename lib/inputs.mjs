import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Folder inside the checkout where Claude Code finds its inputs. */
export const INPUT_DIR = ".crc-brief";

/**
 * Runs a command without a shell and returns its standard output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options] `env` is added to the current environment.
 * @returns {Promise<string>}
 */
export function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
        } else resolve(stdout);
      },
    );
  });
}

const isCommitId = (value) => typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);

/**
 * Writes what Claude Code reads into `<cwd>/.crc-brief/`:
 * pr.json (the pull request's facts and text), diff.patch (what the branch changed)
 * and commits.txt (each commit's full message, oldest first).
 * Claude Code has no shell, so it cannot produce these itself.
 * @param {{ cwd: string, pr: { baseSha: string, headSha: string }, run: typeof runCommand }} input
 */
export async function writeBriefInputs({ cwd, pr, run }) {
  // The ids become git arguments. Anything else could be read as an option.
  for (const id of [pr.baseSha, pr.headSha]) {
    if (!isCommitId(id)) throw new Error(`"${id}" is not a commit id.`);
  }
  // Three dots: the changes on the branch since it left the base, as GitHub shows a pull request.
  const diff = await run("git", ["diff", "--no-color", "--no-ext-diff", `${pr.baseSha}...${pr.headSha}`], { cwd });
  const commits = await run(
    "git",
    ["log", "--no-color", "--reverse", "--format=commit %H%n%n%B%n", `${pr.baseSha}..${pr.headSha}`],
    { cwd },
  );
  const dir = join(cwd, INPUT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pr.json"), JSON.stringify(pr, null, 2) + "\n");
  writeFileSync(join(dir, "diff.patch"), diff);
  writeFileSync(join(dir, "commits.txt"), commits);
}
