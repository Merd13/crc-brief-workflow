import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_NAME, installPlan } from "../host/install.mjs";
import { createDecoder, encodeMessage } from "../host/protocol.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const installer = join(repoDir, "host/install.mjs");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const base = { extensionId: ID, platform: "darwin", homeDir: "/Users/x", nodePath: "/opt/node/bin/node", claudePath: "/Users/x/.local/bin/claude", repoDir: "/Users/x/crc-brief-workflow" };

test("the host name is the one the extension connects to", () => {
  assert.equal(HOST_NAME, "com.code_review_companion.brief_host");
});

test("macOS paths and manifest", () => {
  const plan = installPlan(base);
  assert.equal(plan.manifestPath, "/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.code_review_companion.brief_host.json");
  assert.equal(plan.launcherPath, "/Users/x/Library/Application Support/crc-brief-host/launcher.sh");
  assert.deepEqual(plan.manifest, {
    name: "com.code_review_companion.brief_host",
    description: "Code Review Companion: writes a brief with the local Claude Code",
    path: plan.launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${ID}/`],
  });
  assert.equal(plan.launcher, "#!/bin/sh\nexec '/opt/node/bin/node' '/Users/x/crc-brief-workflow/host/main.mjs' --claude '/Users/x/.local/bin/claude'\n");
});

test("Linux paths", () => {
  const plan = installPlan({ ...base, platform: "linux", homeDir: "/home/x" });
  assert.equal(plan.manifestPath, "/home/x/.config/google-chrome/NativeMessagingHosts/com.code_review_companion.brief_host.json");
  assert.equal(plan.launcherPath, "/home/x/.local/share/crc-brief-host/launcher.sh");
});

test("a manifest folder can be given, for another Chromium browser", () => {
  const plan = installPlan({ ...base, manifestDir: "/tmp/hosts" });
  assert.equal(plan.manifestPath, "/tmp/hosts/com.code_review_companion.brief_host.json");
});

test("paths with a space or a quote survive in the launcher", () => {
  const plan = installPlan({ ...base, repoDir: "/Users/x/Mer's Work Spaces/crc brief", claudePath: "/Users/x/it's/claude" });
  const dir = mkdtempSync(join(tmpdir(), "crc-launcher-"));
  try {
    // Replace `exec` by a command that prints its arguments, one per line, and run the launcher.
    const script = join(dir, "launcher.sh");
    writeFileSync(script, plan.launcher.replace("exec ", "printf '%s\\n' "));
    const printed = spawnSync("sh", [script], { encoding: "utf8" });
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(printed.stdout.trimEnd().split("\n"), [
      "/opt/node/bin/node",
      "/Users/x/Mer's Work Spaces/crc brief/host/main.mjs",
      "--claude",
      "/Users/x/it's/claude",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong extension id is refused", () => {
  for (const extensionId of ["", "abc", ID.toUpperCase(), ID.slice(1) + "q", ID + "a", `${ID}/`, undefined]) {
    assert.throws(() => installPlan({ ...base, extensionId }), /extension id/, String(extensionId));
  }
});

test("Windows is refused", () => {
  assert.throws(() => installPlan({ ...base, platform: "win32" }), /Only macOS and Linux are supported\./);
});

function runInstaller(args, home) {
  return spawnSync(process.execPath, [installer, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("the installer writes a launcher that Chrome can start, and --uninstall removes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "crc-install-"));
  try {
    const manifestDir = join(home, "hosts");
    const installed = runInstaller(["--extension-id", ID, "--claude", "/nonexistent/claude", "--manifest-dir", manifestDir], home);
    assert.equal(installed.status, 0, installed.stderr);
    const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    assert.ok(manifest.path.startsWith(home), "the launcher lives under the given home folder");
    assert.equal(statSync(manifest.path).mode & 0o111, 0o111, "the launcher is executable");
    assert.match(installed.stdout, /Installed\./);
    assert.ok(installed.stdout.includes(manifestPath));

    // Start it the way Chrome does: the launcher itself, with a bare environment.
    const child = spawn(manifest.path, [`chrome-extension://${ID}/`], { stdio: ["pipe", "pipe", "inherit"], env: { HOME: home, PATH: "/usr/bin:/bin" } });
    const reply = await new Promise((resolve) => {
      child.stdout.on("data", createDecoder(resolve, () => {}));
      child.stdin.write(encodeMessage({ id: 1, type: "ping" }));
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.value.claude.path, "/nonexistent/claude");
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));

    const removed = runInstaller(["--uninstall", "--manifest-dir", manifestDir], home);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(manifest.path), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the installer explains itself when the extension id is missing or wrong", () => {
  const home = mkdtempSync(join(tmpdir(), "crc-install-"));
  try {
    const missing = runInstaller([], home);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--extension-id/);
    const wrong = runInstaller(["--extension-id", "nope", "--manifest-dir", join(home, "hosts")], home);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /extension id/);
    assert.equal(existsSync(join(home, "hosts")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
