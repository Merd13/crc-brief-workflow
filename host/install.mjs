#!/usr/bin/env node
// Registers the local helper with Chrome for one extension.
//   node host/install.mjs --extension-id <id> [--claude <path>] [--manifest-dir <dir>]
//   node host/install.mjs --uninstall [--manifest-dir <dir>]
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../lib/actions.mjs";

/** The name the extension connects to. Chrome looks for a manifest file with this name. */
export const HOST_NAME = "com.code_review_companion.brief_host";

// Chrome's ids are 32 letters from a to p.
const isExtensionId = (value) => typeof value === "string" && /^[a-p]{32}$/.test(value);
// For a POSIX shell: inside single quotes only the single quote itself needs care.
const quote = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";

/**
 * Works out what an install writes, without writing it.
 * @param {{ extensionId: string, platform: string, homeDir: string, nodePath: string, claudePath: string,
 *           repoDir: string, manifestDir?: string }} input
 * @returns {{ manifestPath: string, launcherPath: string, manifest: object, launcher: string }}
 */
export function installPlan({ extensionId, platform, homeDir, nodePath, claudePath, repoDir, manifestDir }) {
  const { defaultManifestDir, launcherPath } = locations(platform, homeDir);
  if (!isExtensionId(extensionId)) {
    throw new Error("That is not an extension id. Copy the id from the extension's Settings page: 32 letters from a to p.");
  }
  return {
    manifestPath: join(manifestDir ?? defaultManifestDir, `${HOST_NAME}.json`),
    launcherPath,
    manifest: {
      name: HOST_NAME,
      description: "Code Review Companion: writes a brief with the local Claude Code",
      path: launcherPath,
      type: "stdio",
      // Only this extension may start the helper.
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    // Chrome starts a helper with a bare environment, so nothing here may rely on PATH.
    launcher: `#!/bin/sh\nexec ${quote(nodePath)} ${quote(join(repoDir, "host/main.mjs"))} --claude ${quote(claudePath)}\n`,
  };
}

function locations(platform, homeDir) {
  if (platform === "darwin") {
    return {
      defaultManifestDir: join(homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
      launcherPath: join(homeDir, "Library/Application Support/crc-brief-host/launcher.sh"),
    };
  }
  if (platform === "linux") {
    return {
      defaultManifestDir: join(homeDir, ".config/google-chrome/NativeMessagingHosts"),
      launcherPath: join(homeDir, ".local/share/crc-brief-host/launcher.sh"),
    };
  }
  throw new Error("Only macOS and Linux are supported.");
}

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function findClaude() {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function main(args) {
  const manifestDir = option(args, "--manifest-dir");
  if (args.includes("--uninstall")) {
    const { defaultManifestDir, launcherPath } = locations(process.platform, homedir());
    const manifestPath = join(manifestDir ?? defaultManifestDir, `${HOST_NAME}.json`);
    rmSync(manifestPath, { force: true });
    rmSync(launcherPath, { force: true });
    console.log(`Removed.\n  ${manifestPath}\n  ${launcherPath}`);
    return;
  }

  const extensionId = option(args, "--extension-id");
  if (!extensionId) {
    throw new Error("Usage: node host/install.mjs --extension-id <id>\nThe extension's Settings page shows this command with your id filled in.");
  }
  const claudePath = option(args, "--claude") ?? findClaude();
  if (!claudePath) {
    throw new Error("Could not find Claude Code. Install it (https://code.claude.com), or give its path with --claude <path>.");
  }
  const plan = installPlan({
    extensionId,
    platform: process.platform,
    homeDir: homedir(),
    nodePath: process.execPath,
    claudePath,
    repoDir: fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
    manifestDir,
  });
  mkdirSync(dirname(plan.launcherPath), { recursive: true });
  writeFileSync(plan.launcherPath, plan.launcher);
  chmodSync(plan.launcherPath, 0o755);
  mkdirSync(dirname(plan.manifestPath), { recursive: true });
  writeFileSync(plan.manifestPath, JSON.stringify(plan.manifest, null, 2) + "\n");

  console.log(
    [
      "Installed.",
      `  Chrome manifest: ${plan.manifestPath}`,
      `  Launcher:        ${plan.launcherPath}`,
      `  Node:            ${process.execPath}`,
      `  Claude Code:     ${claudePath}`,
      ...(existsSync(claudePath) ? [] : [`  Warning: nothing exists at ${claudePath} yet.`]),
      "",
      "Next: open the extension's Settings and select Check again.",
      "Run this command again after you move this folder, or after Node or Claude Code moves.",
    ].join("\n"),
  );
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
