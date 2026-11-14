import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Splits file text into lines. Counts the same way as the CRC extension. */
export function toLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Reads files of the checked-out repository by repository-relative path.
 * Returns null for anything that is not a regular file inside `root`, and does not read it.
 * @param {string} root
 * @returns {(path: string) => string[] | null}
 */
export function workspaceReader(root) {
  const realRoot = realpathSync(root);
  return (path) => {
    if (typeof path !== "string" || path === "" || isAbsolute(path)) return null;
    if (path.split(/[\\/]/).includes("..")) return null;
    try {
      // realpath follows symlinks, so a link that points outside the repository is refused too.
      const real = realpathSync(resolve(realRoot, path));
      const rel = relative(realRoot, real);
      if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
      if (!statSync(real).isFile()) return null;
      return toLines(readFileSync(real, "utf8"));
    } catch {
      return null;
    }
  };
}

/**
 * Removes code references that do not exist at the brief's head commit.
 * The item stays; each removed reference is recorded in meta.droppedAnchors.
 * @param {any} brief
 * @param {(path: string) => string[] | null} readLines
 */
export function checkAnchors(brief, readLines) {
  const dropped = [];
  const items = brief.items.map((item) => {
    const sourceRefs = item.sourceRefs.filter((ref) => {
      const lines = readLines(ref.path);
      if (!lines) {
        dropped.push({ itemId: item.id, path: ref.path, reason: "The file does not exist at the brief's head commit." });
        return false;
      }
      if (ref.endLine > lines.length) {
        dropped.push({
          itemId: item.id,
          path: ref.path,
          reason: `Lines ${ref.startLine}-${ref.endLine} are past the end of the file (${lines.length} lines).`,
        });
        return false;
      }
      return true;
    });
    return { ...item, sourceRefs };
  });
  const meta = dropped.length
    ? { ...brief.meta, droppedAnchors: [...(brief.meta.droppedAnchors ?? []), ...dropped] }
    : brief.meta;
  return { ...brief, items, meta };
}
