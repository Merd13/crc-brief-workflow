import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBrief, GUIDANCE_VERSION } from "../lib/assemble.mjs";
import { parseBriefFile } from "../contract/contract.mjs";
import { exampleGeneration, examplePr, now } from "./helpers.mjs";

test("assembled brief passes the contract", () => {
  const brief = assembleBrief({ generation: exampleGeneration(), pr: examplePr, model: "claude-opus-5-5", now });
  const parsed = parseBriefFile(brief);
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
});

test("PR facts and meta come from the workflow, not from Claude", () => {
  const generation = { ...exampleGeneration(), pr: { number: 999 }, meta: { source: "import" }, schemaVersion: 7 };
  const brief = assembleBrief({ generation, pr: examplePr, model: "m", now });
  assert.equal(brief.schemaVersion, 1);
  assert.deepEqual(brief.pr, { ...examplePr });
  assert.deepEqual(brief.meta, { source: "generated", generatedAt: now, guidanceVersion: "v0.2", model: "m" });
  assert.equal(GUIDANCE_VERSION, "v0.2");
});

test("only the seven contract PR fields are kept", () => {
  const brief = assembleBrief({ generation: exampleGeneration(), pr: { ...examplePr, body: "text", commits: [] }, model: "m", now });
  assert.deepEqual(Object.keys(brief.pr), ["org", "repo", "number", "url", "title", "headSha", "baseSha"]);
});
