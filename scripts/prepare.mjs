// Step: find the pull request, save its facts for Claude Code and the posting step,
// and set the outputs the next steps need.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorLine, githubHeaders, isMain } from "../lib/actions.mjs";

/**
 * The pull request this run is for: the event's own PR, or the pr_number input of a manual run.
 * @param {{ eventName: string, event: any, input?: string }} run
 * @returns {number}
 */
export function resolvePrNumber({ event, input }) {
  const fromEvent = event?.pull_request?.number;
  if (Number.isInteger(fromEvent) && fromEvent > 0) return fromEvent;
  const text = String(input ?? "").trim();
  if (text === "") throw new Error("No pull request number. A manual run needs the pr_number input.");
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`"${text}" is not a pull request number.`);
  return Number(text);
}

async function getJson(fetch, url, token, notFound) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (response.status === 404 && notFound) throw Object.assign(new Error(notFound), { code: "not_found" });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${new URL(url).pathname}.`);
  return response.json();
}

/**
 * Reads the pull request and its commits from GitHub.
 * @param {{ repo: string, number: number, fetch: typeof fetch, token: string, apiUrl?: string }} input
 *   `repo` is "owner/name".
 */
export async function prepare({ repo, number, fetch, token, apiUrl = "https://api.github.com" }) {
  const [org, name] = repo.split("/");
  const base = `${apiUrl}/repos/${repo}/pulls/${number}`;
  const pull = await getJson(fetch, base, token, `Pull request #${number} was not found in ${repo}.`);
  // A fork's branch is code from outside the repository. A manual run would give it the
  // generation credential, so it is refused here, for every kind of run.
  const headRepo = pull.head?.repo?.full_name;
  if (!headRepo || headRepo.toLowerCase() !== repo.toLowerCase()) {
    throw Object.assign(
      new Error(
        `Pull request #${number} comes from a fork (${headRepo ?? "a deleted repository"}). Briefs are written only for branches of ${repo}.`,
      ),
      { code: "fork" },
    );
  }
  const commits = [];
  // GitHub lists at most 250 commits for a pull request: three pages of 100.
  for (let page = 1; page <= 3; page++) {
    const batch = await getJson(fetch, `${base}/commits?per_page=100&page=${page}`, token);
    commits.push(...batch.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" })));
    if (batch.length < 100) break;
  }
  return {
    org,
    repo: name,
    number: pull.number,
    url: pull.html_url,
    title: pull.title ?? "",
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    commits,
  };
}

/** Fills the prompt template. Only the repository name, the PR number and commit ids go in. */
export function buildPrompt(template, { repo, number, baseSha, headSha }) {
  const values = { REPO: repo, PR_NUMBER: String(number), BASE_SHA: baseSha, HEAD_SHA: headSha };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown placeholder ${match} in the prompt.`);
    return values[key];
  });
}

/** Step outputs in GitHub's delimiter form, which allows a value to span lines. */
export function formatOutputs(outputs, delimiter) {
  let text = "";
  for (const [name, value] of Object.entries(outputs)) {
    if (String(value).split("\n").includes(delimiter)) throw new Error(`Output ${name} contains the delimiter.`);
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  return text;
}

async function main(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const number = resolvePrNumber({ eventName: env.GITHUB_EVENT_NAME, event, input: env.INPUT_PR_NUMBER });
  const facts = await prepare({
    repo: env.GITHUB_REPOSITORY,
    number,
    fetch,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || undefined,
  });
  writeFileSync(env.CRC_PR_FILE, JSON.stringify(facts, null, 2) + "\n");
  const template = readFileSync(join(env.CRC_HOME, "prompt/brief-prompt.md"), "utf8");
  const outputs = {
    number: String(facts.number),
    head_sha: facts.headSha,
    base_sha: facts.baseSha,
    schema: readFileSync(join(env.CRC_HOME, "contract/generation.schema.json"), "utf8").trim(),
    prompt: buildPrompt(template, { repo: env.GITHUB_REPOSITORY, number: facts.number, baseSha: facts.baseSha, headSha: facts.headSha }),
  };
  appendFileSync(env.GITHUB_OUTPUT, formatOutputs(outputs, `crc-${randomUUID()}`));
  console.log(`Pull request #${facts.number}: ${facts.commits.length} commit(s), head ${facts.headSha}, base ${facts.baseSha}`);
}

if (isMain(import.meta.url)) {
  main(process.env).catch((error) => {
    console.log(errorLine(error.message));
    process.exit(1);
  });
}
