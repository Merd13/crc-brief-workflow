// How Claude Code is limited while it writes a brief.
// The Action's `claude_args` in .github/workflows/brief.yml must use the same tool values;
// test/claude-args.test.mjs checks that.

/** The only tools Claude Code gets. There is no shell and nothing that writes. */
export const TOOLS = "Read,Grep,Glob";

/**
 * Each tool is allowed only inside the checkout.
 * A bare tool name (for example "Read") would allow it on every path of the machine.
 */
export const ALLOWED_TOOLS = ["Read(./**)", "Grep(./**)", "Glob(./**)"];

/**
 * Arguments for a local `claude` run that returns the brief as structured output.
 * No settings are loaded: not the repository's, not the user's. That keeps hooks,
 * plugins and MCP servers of both out of a run on pull request code.
 * @param {{ model: string, schema: string, prompt: string }} input
 * @returns {string[]}
 */
export function localClaudeArgs({ model, schema, prompt }) {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--tools",
    TOOLS,
    "--allowedTools",
    ...ALLOWED_TOOLS,
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
    schema,
  ];
}
