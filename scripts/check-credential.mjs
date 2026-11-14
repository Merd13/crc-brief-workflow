// Step: fail before Claude Code starts unless exactly one generation credential is set.
import { pickCredential } from "../lib/credential.mjs";
import { errorLine } from "../lib/actions.mjs";

const result = pickCredential({ apiKey: process.env.CRC_API_KEY, oauthToken: process.env.CRC_OAUTH_TOKEN });
if (!result.ok) {
  console.log(errorLine(result.error));
  process.exit(1);
}
console.log(`Generation credential: ${result.kind === "api_key" ? "API key" : "subscription token"}`);
