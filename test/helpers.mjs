import { readFileSync } from "node:fs";

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
