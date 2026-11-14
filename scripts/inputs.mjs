// Step: write the pull request's text, diff and commit log into the checkout for Claude Code.
import { readFileSync } from "node:fs";
import { errorLine } from "../lib/actions.mjs";
import { runCommand, writeBriefInputs } from "../lib/inputs.mjs";

try {
  const pr = JSON.parse(readFileSync(process.env.CRC_PR_FILE, "utf8"));
  await writeBriefInputs({ cwd: process.env.GITHUB_WORKSPACE, pr, run: runCommand });
  console.log("Wrote .crc-brief/pr.json, .crc-brief/diff.patch and .crc-brief/commits.txt");
} catch (error) {
  console.log(errorLine(error.message));
  process.exit(1);
}
