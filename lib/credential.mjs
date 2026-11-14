export const API_KEY_SECRET = "CRC_ANTHROPIC_API_KEY";
export const OAUTH_TOKEN_SECRET = "CRC_CLAUDE_CODE_OAUTH_TOKEN";

const isSet = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A repository sets exactly one generation credential.
 * Two would hide which account a run bills, so that is refused as well as none.
 * @param {{ apiKey?: string, oauthToken?: string }} secrets
 * @returns {{ ok: true, kind: "api_key" | "oauth_token" } | { ok: false, error: string }}
 */
export function pickCredential({ apiKey, oauthToken }) {
  const hasKey = isSet(apiKey);
  const hasToken = isSet(oauthToken);
  if (hasKey && hasToken) {
    return {
      ok: false,
      error: `Two generation credentials are set. Keep only one of the repository secrets ${API_KEY_SECRET} and ${OAUTH_TOKEN_SECRET}.`,
    };
  }
  if (hasKey) return { ok: true, kind: "api_key" };
  if (hasToken) return { ok: true, kind: "oauth_token" };
  return {
    ok: false,
    error: `No generation credential. Set the repository secret ${API_KEY_SECRET} (Anthropic API key) or ${OAUTH_TOKEN_SECRET} (Claude subscription token).`,
  };
}
