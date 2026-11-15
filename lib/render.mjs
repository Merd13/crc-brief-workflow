// The brief comment: readable markdown, then the brief JSON inside an HTML comment.
// README.md ("Comment format") describes this layout for readers such as the CRC extension.

/** First line of every brief comment. */
export const BRIEF_MARKER = "<!-- crc-brief:v1 -->";
/** The line before the JSON line. The line after the JSON line is `-->`. */
export const DATA_OPEN = "<!-- crc-brief-data";
const DATA_CLOSE = "-->";
/** GitHub's limit for a comment body, in characters. */
export const COMMENT_CAP = 65536;

export class BriefTooLargeError extends Error {
  constructor(size, cap) {
    super(`The brief comment is ${size} characters; GitHub allows ${cap}.`);
    this.name = "BriefTooLargeError";
    this.size = size;
    this.cap = cap;
  }
}

// A zero-width space. Written as a code so it stays visible in this file.
const ZWSP = String.fromCharCode(0x200b);

/**
 * Makes brief text safe for the readable part of the comment.
 *
 * Brief text comes from a model that read pull request text, so it is untrusted. Every sequence
 * that GitHub would turn into something live gets a zero-width space inside it:
 * an HTML tag or comment, a mention, a link or image, a character entity, and a code fence.
 * The text looks the same and keeps every character.
 *
 * The rule is the same everywhere. It does not try to tell prose from code, because GitHub and
 * this file would not always agree on where code starts, and a wrong guess would let markup through.
 * A code fence in particular must never open: one left open would show the hidden data block.
 */
export function safeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/<(?=[A-Za-z\/!?])/g, "<" + ZWSP)
    .replace(/@(?=[A-Za-z0-9_-])/g, "@" + ZWSP)
    .replace(/\](?=[(\[:])/g, "]" + ZWSP)
    .replace(/&(?=[#A-Za-z])/g, "&" + ZWSP)
    .replace(/^([ \t]*)(?=`{3,}|~{3,})/gm, "$1" + ZWSP);
}

/** One line of JSON that cannot contain `-->`. JSON.parse reads it unchanged. */
export function encodeData(brief) {
  return JSON.stringify(brief).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * Reads the brief JSON from a comment body.
 * Returns null when the body is not a brief comment or its data does not parse.
 * It does not validate the brief against the contract.
 */
export function extractBrief(body) {
  if (typeof body !== "string") return null;
  const lines = body.split(/\r?\n/);
  if (lines[0] !== BRIEF_MARKER) return null;
  const open = lines.lastIndexOf(DATA_OPEN);
  if (open === -1 || open + 1 >= lines.length) return null;
  try {
    return JSON.parse(lines[open + 1]);
  } catch {
    return null;
  }
}

const oneLine = (text) => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ");
const code = (text) => "`" + safeText(oneLine(text).replaceAll("`", "'")) + "`";
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

function anchorLink(pr, ref) {
  const range = `L${ref.startLine}-L${ref.endLine}`;
  const url = `https://github.com/${pr.org}/${pr.repo}/blob/${pr.headSha}/${encodePath(ref.path)}#${range}`;
  return `[${code(ref.path)} ${range}](${url})`;
}

function contextSection(context) {
  const out = ["### Context", ""];
  const paragraph = (label, text) => {
    if (text && text.trim() !== "") out.push(`**${label}:** ${safeText(text)}`, "");
  };
  const list = (label, entries, format) => {
    if (entries.length) out.push(`**${label}:**`, "", ...entries.map((entry) => `- ${format(entry)}`), "");
  };
  paragraph("Problem, as documented", context.problem.documented);
  paragraph("Problem, as interpreted", context.problem.interpretation);
  paragraph("Approach", context.approach);
  list("Components", context.components, (entry) => code(entry));
  list("Not confirmed", context.uncertainties, (entry) => safeText(oneLine(entry)));
  return out;
}

function readingPathSection(readingPath) {
  if (!readingPath.length) return [];
  return [
    "### Reading path",
    "",
    ...readingPath.map((step, i) => `${i + 1}. ${code(step.path)}: ${safeText(oneLine(step.why))}`),
    "",
  ];
}

function itemSection(heading, items, pr, compact) {
  if (!items.length) return [];
  const out = [`### ${heading} (${items.length})`, ""];
  if (compact) {
    out.push(...items.map((item) => `- ${safeText(oneLine(item.title))}`), "");
    return out;
  }
  for (const item of items) {
    out.push(`#### ${safeText(oneLine(item.title))}`, "", safeText(item.content), "");
    // Two trailing spaces are a markdown line break: one code reference per line.
    if (item.sourceRefs.length) {
      out.push(...item.sourceRefs.map((ref, i, all) => anchorLink(pr, ref) + (i < all.length - 1 ? "  " : "")), "");
    }
  }
  return out;
}

function readable(brief, runUrl, compact) {
  const { pr, meta } = brief;
  const by = meta.model ? ` with ${safeText(oneLine(meta.model))}` : "";
  // A run in GitHub Actions links to itself. A run on a reviewer's machine has nothing to link to.
  // A brief that a reviewer imported from a file was not generated here.
  const origin = runUrl
    ? `Generated by Code Review Companion${by} ([run](${runUrl})).`
    : meta.source === "generated"
      ? `Generated locally by Code Review Companion${by}.`
      : "Imported into Code Review Companion.";
  const out = [
    "## Review brief",
    "",
    `For commit ${code(pr.headSha.slice(0, 7))} of #${pr.number}. ${origin}`,
    "",
    ...contextSection(brief.context),
    ...readingPathSection(brief.readingPath),
  ];
  if (!brief.items.length) {
    out.push("No takeaways for this PR.", "");
  } else {
    out.push(
      ...itemSection("Checks", brief.items.filter((item) => item.type === "check"), pr, compact),
      ...itemSection("Learnings", brief.items.filter((item) => item.type === "learning"), pr, compact),
    );
    if (compact) {
      out.push(
        "_Item text is left out here because of GitHub's comment size limit. Open the PR with Code Review Companion to read it._",
        "",
      );
    }
  }
  const dropped = meta.droppedAnchors?.length ?? 0;
  if (dropped) out.push(`_${dropped} code reference(s) were removed because they do not exist at this commit._`, "");
  return out.join("\n");
}

/**
 * Renders the comment body for a brief that already passed the contract.
 * Falls back to a compact readable part when the full body is over the cap.
 * @param {any} brief
 * @param {{ runUrl?: string, cap?: number }} [options] `runUrl`: the GitHub Actions run. Leave it out for a local run.
 * @returns {{ body: string, compact: boolean }}
 * @throws {BriefTooLargeError} when the compact body is over the cap too
 */
export function renderComment(brief, { runUrl, cap = COMMENT_CAP } = {}) {
  const data = `${DATA_OPEN}\n${encodeData(brief)}\n${DATA_CLOSE}\n`;
  const build = (compact) => `${BRIEF_MARKER}\n${readable(brief, runUrl, compact)}\n${data}`;
  const full = build(false);
  if (full.length <= cap) return { body: full, compact: false };
  const compact = build(true);
  if (compact.length <= cap) return { body: compact, compact: true };
  throw new BriefTooLargeError(compact.length, cap);
}
