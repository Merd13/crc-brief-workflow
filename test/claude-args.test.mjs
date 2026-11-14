import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWED_TOOLS, TOOLS, localClaudeArgs } from "../lib/claude-args.mjs";

test("the local run gets exactly these flags", () => {
  assert.deepEqual(localClaudeArgs({ model: "claude-opus-5-5", schema: '{"type":"object"}', prompt: "Write the brief." }), [
    "-p",
    "Write the brief.",
    "--model",
    "claude-opus-5-5",
    "--tools",
    "Read,Grep,Glob",
    "--allowedTools",
    "Read(./**)",
    "Grep(./**)",
    "Glob(./**)",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    '{"type":"object"}',
  ]);
});

test("Claude Code gets no shell and no tool that writes", () => {
  const args = localClaudeArgs({ model: "m", schema: "{}", prompt: "p" }).join(" ");
  for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) assert.equal(args.includes(tool), false, tool);
  assert.equal(TOOLS, "Read,Grep,Glob");
  // A bare tool name would allow that tool on any path of the machine.
  for (const rule of ALLOWED_TOOLS) assert.match(rule, /^(Read|Grep|Glob)\(\.\/\*\*\)$/);
});

test("the Action uses the same tool limits", () => {
  const workflow = readFileSync(new URL("../.github/workflows/brief.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes(`--tools "${TOOLS}"`));
  assert.ok(workflow.includes(`--allowedTools "${ALLOWED_TOOLS.join(",")}"`));
  assert.equal(workflow.includes("Bash("), false);
  // The repository's own Claude settings, hooks and MCP servers must not shape the run.
  assert.ok(workflow.includes("--setting-sources user"));
  assert.ok(workflow.includes("--strict-mcp-config"));
  assert.equal(/--allowedTools "[^"]*\b(Read|Grep|Glob)[,"]/.test(workflow), false, "no bare tool rule");
});
