/** Version of the extraction guidance that prompt/brief-prompt.md follows. */
export const GUIDANCE_VERSION = "v0.2";

/**
 * Builds a brief in the contract format.
 * Claude Code supplies only the judgment parts (context, reading path, items).
 * The PR facts and the metadata come from the workflow, so the model cannot get them wrong.
 * @param {{ generation: any, pr: any, model: string, now: string }} input
 */
export function assembleBrief({ generation, pr, model, now }) {
  return {
    schemaVersion: 1,
    pr: {
      org: pr.org,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    },
    context: generation?.context,
    readingPath: generation?.readingPath,
    items: generation?.items,
    meta: { source: "generated", generatedAt: now, guidanceVersion: GUIDANCE_VERSION, model },
  };
}
