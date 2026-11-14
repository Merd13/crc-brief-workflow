import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A GitHub Actions error annotation. Line breaks are escaped so the message stays in one command. */
export function errorLine(message) {
  return "::error::" + String(message).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** True when the module at `metaUrl` is the file that `node` was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "crc-brief-workflow",
  };
}
