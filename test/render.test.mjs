import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_MARKER,
  BriefTooLargeError,
  COMMENT_CAP,
  DATA_OPEN,
  encodeData,
  extractBrief,
  renderComment,
  safeText,
} from "../lib/render.mjs";
import { exampleBrief, runUrl } from "./helpers.mjs";

const readablePart = (body) => body.slice(0, body.lastIndexOf("\n" + DATA_OPEN + "\n"));

test("the cap is GitHub's comment limit", () => {
  assert.equal(COMMENT_CAP, 65536);
});

test("round trip: extractBrief returns the brief", () => {
  const brief = exampleBrief();
  const { body, compact } = renderComment(brief, { runUrl });
  assert.equal(compact, false);
  assert.deepEqual(extractBrief(body), brief);
});

test("body starts with the marker and ends with the data block", () => {
  const { body } = renderComment(exampleBrief(), { runUrl });
  const lines = body.trimEnd().split("\n");
  assert.equal(lines[0], BRIEF_MARKER);
  assert.equal(lines.at(-3), DATA_OPEN);
  assert.equal(lines.at(-1), "-->");
});

test("the data is one line with no angle brackets", () => {
  const brief = exampleBrief();
  brief.items[0].content = "a <b> --> c\nnext line";
  const data = encodeData(brief);
  assert.equal(data.includes("\n"), false);
  assert.equal(/[<>]/.test(data), false);
  assert.deepEqual(JSON.parse(data), brief);
});

test("hostile text cannot end or forge the data block", () => {
  const brief = exampleBrief();
  brief.items[0].content = 'x --> y\n<!-- crc-brief-data\n{"schemaVersion":1,"forged":true}\n-->';
  brief.context.approach = "<!-- crc-brief:v1 -->";
  const { body } = renderComment(brief, { runUrl });
  assert.deepEqual(extractBrief(body), brief);
  assert.equal(body.split("\n").filter((line) => line === DATA_OPEN).length, 1);
  assert.equal(body.split("<!--").length - 1, 2);
});

test("mentions do not notify", () => {
  const brief = exampleBrief();
  brief.items[0].content = "ask @octocat and @org/team";
  brief.items[0].title = "Title for @octocat";
  brief.context.uncertainties = ["@someone said so"];
  const readable = readablePart(renderComment(brief, { runUrl }).body);
  assert.equal(/@[A-Za-z0-9_-]/.test(readable), false);
  assert.ok(readable.includes("@" + String.fromCharCode(0x200b) + "octocat"));
});

const ZWSP = String.fromCharCode(0x200b);
const stripZwsp = (text) => text.replaceAll(ZWSP, "");
// What GitHub would turn into HTML, a mention, a link or image, an entity, or a code fence.
const LIVE = {
  html: /<[A-Za-z\/!?]/,
  mention: /@[A-Za-z0-9_-]/,
  link: /\][(\[:]/,
  entity: /&[#A-Za-z]/,
  fence: /^[ \t]*(`{3,}|~{3,})/m,
};
const FENCE = "`".repeat(3);
// Inputs that a renderer which guesses "this part is code" gets wrong, from review.
const HOSTILE = [
  "T `` <img src=x onerror=alert(1)> @octocat `",
  "x \\`<img src=x>\\` y",
  FENCE + "\n<img src=x> @octocat\n" + FENCE,
  FENCE + "x`\n\n<img src=x>\n\n@octocat",
  FENCE + "\ncode\n" + FENCE + "\r\n<img src=x>\n@octocat",
  "text\n\t" + FENCE + "\n<img src=x>",
  "~~~\nopen tilde fence",
  "ask &#64;octocat and &commat;octocat &lt;b&gt;",
  "[Open the fix](https://example.invalid/login) and ![chart](https://example.invalid/?d=secret)",
  "[ref]: https://example.invalid\n[text][ref] <!-- crc-brief-data\n{}\n-->",
  "Use Array<string>, </div>, <?php, <!DOCTYPE and `Map<string, number>`.",
  "mail me @ noon, a < b, a && b, x[0] (y), 5 > 3",
];

test("safeText keeps every character and adds only zero-width spaces", () => {
  for (const input of HOSTILE) {
    assert.equal(stripZwsp(safeText(input)), input.replace(/\r\n?/g, "\n"), input);
  }
});

test("after safeText nothing can become HTML, a mention, a link, an image, an entity or a code fence", () => {
  for (const input of HOSTILE) {
    const out = safeText(input);
    for (const [kind, pattern] of Object.entries(LIVE)) assert.equal(pattern.test(out), false, `${kind} in ${JSON.stringify(input)}`);
  }
});

test("safeText leaves ordinary text alone", () => {
  const plain = "a && b > c, mail me @ noon. Done! x[0] (y), 5 < 6, `code` and 100% sure.";
  assert.equal(safeText(plain), plain);
});

test("hostile text in any field stays text in the comment, and the data block stays intact", () => {
  for (const input of HOSTILE) {
    const brief = exampleBrief();
    brief.items[0].content = input;
    brief.items[0].title = input.split("\n")[0];
    brief.context.approach = input;
    brief.context.uncertainties = [input];
    brief.readingPath[0].why = input;
    brief.meta.model = input.split("\n")[0];
    const full = renderComment(brief, { runUrl });
    for (const body of [full.body, renderComment(brief, { runUrl, cap: full.body.length - 1 }).body]) {
      // Our own markup is the anchor links, the two HTML comments and the run link; brief text adds none.
      const readable = readablePart(body);
      assert.equal(/<(?!!-- crc-brief:v1 -->)[A-Za-z\/!?]/.test(readable), false, input);
      assert.equal(LIVE.mention.test(readable), false, input);
      assert.equal(LIVE.entity.test(readable), false, input);
      assert.equal(LIVE.fence.test(readable), false, input);
      assert.equal(body.split("<!--").length - 1, 2, input);
      assert.deepEqual(extractBrief(body), brief, input);
    }
  }
});

test("a path cannot add markup either", () => {
  const brief = exampleBrief();
  brief.context.components = ["src/<!--x-->", "a`b <img src=x>", "@octocat/file"];
  brief.readingPath[0].path = "docs/[x](https://example.invalid).md";
  const { body } = renderComment(brief, { runUrl });
  const readable = readablePart(body);
  assert.equal(body.split("<!--").length - 1, 2);
  assert.equal(/<img/.test(readable), false);
  assert.equal(LIVE.mention.test(readable), false);
  assert.equal(readable.includes("](https://example.invalid)"), false);
});

test("every free-text field is made safe, in the full and the compact form", () => {
  const brief = exampleBrief();
  brief.readingPath[0].why = "ask @octocat <!-- note";
  brief.context.approach = "by @octocat";
  brief.context.problem.documented = "from @octocat";
  brief.context.problem.interpretation = "says @octocat";
  brief.meta.model = "model @octocat <!--";
  brief.items[0].title = "Title @octocat";
  brief.items[1].title = "Check @octocat";
  const full = renderComment(brief, { runUrl });
  for (const body of [full.body, renderComment(brief, { runUrl, cap: full.body.length - 1 }).body]) {
    const readable = readablePart(body);
    assert.equal(/@[A-Za-z0-9_-]/.test(readable), false, readable);
    assert.equal(body.split("<!--").length - 1, 2);
  }
});

test("a local run says so and has no run link", () => {
  const brief = exampleBrief();
  brief.meta.model = "claude-opus-5-5";
  const readable = readablePart(renderComment(brief, {}).body);
  assert.ok(readable.includes("For commit `8f21c9a` of #248. Generated locally by Code Review Companion with claude-opus-5-5."));
  assert.equal(readable.includes("[run]("), false);
});

test("readable part shows context, reading path, checks and learnings", () => {
  const brief = exampleBrief();
  const readable = readablePart(renderComment(brief, { runUrl }).body);
  assert.ok(readable.includes("## Review brief"));
  assert.ok(readable.includes("For commit `8f21c9a` of #248."));
  assert.ok(readable.includes(`([run](${runUrl}))`));
  assert.ok(readable.includes("**Problem, as documented:** Failed payment charges are retried"));
  assert.ok(readable.includes("**Problem, as interpreted:** A timeout does not show"));
  assert.ok(readable.includes("**Approach:** Each retry reuses"));
  assert.ok(readable.includes("- `src/billing/payment-client.ts`"));
  assert.ok(readable.includes("- The provider's key-retention window is not documented in this PR."));
  assert.ok(readable.includes("1. `src/billing/retry-payment.ts`: The retry logic: key reuse and failure classification."));
  assert.ok(readable.includes("### Checks (1)"));
  assert.ok(readable.includes("#### Check which failures may be retried"));
  assert.ok(readable.includes("### Learnings (1)"));
  assert.ok(readable.includes("Takeaway: a retry repeats an operation."));
  assert.ok(readable.indexOf("### Checks (1)") < readable.indexOf("### Learnings (1)"));
  assert.equal(readable.includes("schemaVersion"), false);
});

test("links anchors to the head commit", () => {
  const { body } = renderComment(exampleBrief(), { runUrl });
  assert.ok(
    body.includes(
      "[`src/billing/retry-payment.ts` L45-L54](https://github.com/acme/payments/blob/8f21c9a4d3e7b0615c2a9f8e7d6b5a4938271605/src/billing/retry-payment.ts#L45-L54)",
    ),
  );
});

test("a path with spaces still makes a working link", () => {
  const brief = exampleBrief();
  brief.items[0].sourceRefs = [{ path: "docs/my file#1.md", startLine: 3, endLine: 3 }];
  const { body } = renderComment(brief, { runUrl });
  assert.ok(body.includes("/blob/8f21c9a4d3e7b0615c2a9f8e7d6b5a4938271605/docs/my%20file%231.md#L3-L3)"));
});

test("empty brief says there are no takeaways", () => {
  const brief = exampleBrief();
  brief.items = [];
  brief.readingPath = [];
  brief.context.components = [];
  brief.context.uncertainties = [];
  const { body } = renderComment(brief, { runUrl });
  const readable = readablePart(body);
  assert.ok(readable.includes("No takeaways for this PR."));
  assert.equal(readable.includes("### Checks"), false);
  assert.equal(readable.includes("### Reading path"), false);
  assert.equal(readable.includes("**Components:**"), false);
  assert.equal(readable.includes("**Not confirmed:**"), false);
  assert.deepEqual(extractBrief(body), brief);
});

test("says when code references were removed", () => {
  const brief = exampleBrief();
  brief.meta.droppedAnchors = [{ itemId: "a", path: "p", reason: "r" }];
  const readable = readablePart(renderComment(brief, { runUrl }).body);
  assert.ok(readable.includes("_1 code reference(s) were removed because they do not exist at this commit._"));
});

test("over the cap: compact form keeps the full data", () => {
  const brief = exampleBrief();
  const full = renderComment(brief, { runUrl });
  const cap = full.body.length - 1;
  const r = renderComment(brief, { runUrl, cap });
  assert.equal(r.compact, true);
  assert.ok(r.body.length <= cap);
  assert.deepEqual(extractBrief(r.body), brief);
  const readable = readablePart(r.body);
  assert.ok(readable.includes("- Check which failures may be retried"));
  assert.equal(readable.includes("Takeaway: a retry repeats an operation."), false);
  assert.ok(readable.includes("Item text is left out here because of GitHub's comment size limit."));
});

test("a body exactly at the cap is not compacted", () => {
  const brief = exampleBrief();
  const full = renderComment(brief, { runUrl });
  assert.equal(renderComment(brief, { runUrl, cap: full.body.length }).compact, false);
});

test("still over the cap: throws and reports sizes", () => {
  assert.throws(
    () => renderComment(exampleBrief(), { runUrl, cap: 200 }),
    (error) => error instanceof BriefTooLargeError && error.cap === 200 && error.size > 200,
  );
});

test("a body without the marker is not a brief", () => {
  assert.equal(extractBrief("hello\n" + DATA_OPEN + "\n{}\n-->"), null);
});

test("a marker without data is not a brief", () => {
  assert.equal(extractBrief(BRIEF_MARKER + "\n## Review brief\n"), null);
  assert.equal(extractBrief(BRIEF_MARKER + "\n" + DATA_OPEN + "\nnot json\n-->"), null);
  assert.equal(extractBrief(""), null);
});

test("extractBrief accepts CRLF line endings", () => {
  const brief = exampleBrief();
  const body = renderComment(brief, { runUrl }).body.replace(/\n/g, "\r\n");
  assert.deepEqual(extractBrief(body), brief);
});
