#!/usr/bin/env node
// The local helper. Chrome starts it when the CRC extension opens a native messaging port
// and closes its input when the port closes. It answers two requests: "ping" and "generate".
// Standard output carries only framed messages; anything else goes to standard error.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../lib/actions.mjs";
import { runCommand } from "../lib/inputs.mjs";
import { HostError, removeStaleRuns } from "./checkout.mjs";
import { claudeRunner, generate } from "./generate.mjs";
import { createDecoder, encodeMessage } from "./protocol.mjs";

/** Version of the message format. The extension can tell an old helper by it. */
export const HOST_VERSION = "1";

const isId = (value) => typeof value === "string" || typeof value === "number";

/**
 * Handles one request and sends its replies.
 * @param {unknown} message
 * @param {{ send: (message: object) => void, claudePath: string, run: Function, generate: Function,
 *           state: { controller?: AbortController }, logError?: (error: unknown) => void }} context
 */
export async function handleMessage(message, context) {
  const { send } = context;
  if (typeof message !== "object" || message === null || Array.isArray(message) || !isId(message.id)) {
    send({ id: null, ok: false, error: { code: "invalid", message: "Malformed request." } });
    return;
  }
  const { id, type } = message;
  const fail = (code, text) => send({ id, ok: false, error: { code, message: text } });

  if (type === "ping") {
    const claude = { path: context.claudePath, version: null };
    try {
      claude.version = String(await context.run(context.claudePath, ["--version"])).trim().split("\n")[0];
    } catch {
      claude.error = `Could not start Claude Code at ${context.claudePath}. Install it, then run the helper's installer again.`;
    }
    send({ id, ok: true, value: { hostVersion: HOST_VERSION, node: process.version, claude } });
    return;
  }

  if (type === "generate") {
    if (context.state.controller) return fail("busy", "The local helper is already writing a brief.");
    const controller = new AbortController();
    context.state.controller = controller;
    try {
      const result = await context.generate({
        pr: message.pr,
        token: message.token,
        model: message.model,
        signal: controller.signal,
        onProgress: (stage) => send({ id, type: "progress", stage }),
      });
      send({
        id,
        ok: true,
        value: { body: result.body, compact: result.compact, headSha: result.headSha, items: result.brief.items.length, stats: result.stats },
      });
    } catch (error) {
      if (error instanceof HostError) fail(error.code, error.message);
      else {
        // The details stay on this machine: they may hold local paths.
        (context.logError ?? console.error)(error);
        fail("unknown", "The local helper failed unexpectedly.");
      }
    } finally {
      context.state.controller = undefined;
    }
    return;
  }

  fail("invalid", "Unknown request type.");
}

/** Where the helper keeps its clones. */
export function cacheDirFor(platform, env, home) {
  if (platform === "darwin") return join(home, "Library", "Caches", "crc-brief-host");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "crc-brief-host");
}

function main() {
  const flag = process.argv.indexOf("--claude");
  const claudePath = flag === -1 ? undefined : process.argv[flag + 1];
  if (!claudePath) {
    console.error("Usage: node host/main.mjs --claude <path to the claude program>. Run host/install.mjs instead of starting this by hand.");
    process.exit(2);
  }
  const deps = {
    fetch,
    run: runCommand,
    runClaude: claudeRunner(claudePath),
    cacheDir: cacheDirFor(process.platform, process.env, homedir()),
    home: fileURLToPath(new URL("..", import.meta.url)),
    now: () => new Date().toISOString(),
  };
  removeStaleRuns(deps.cacheDir);
  const context = {
    send: (message) => process.stdout.write(encodeMessage(message)),
    claudePath,
    run: runCommand,
    generate: (input) => generate({ ...input, deps }),
    state: {},
  };
  const pending = new Set();
  const feed = createDecoder(
    (message) => {
      const work = handleMessage(message, context).catch((error) => console.error(error));
      pending.add(work);
      work.finally(() => pending.delete(work));
    },
    (error) => console.error(error.message),
  );
  process.stdin.on("data", feed);
  // The port closed (the extension disconnected, or Chrome quit): stop a running brief,
  // let it remove its checkout, then leave.
  process.stdin.on("end", async () => {
    context.state.controller?.abort();
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

if (isMain(import.meta.url)) main();
