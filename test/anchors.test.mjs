import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkAnchors, toLines, workspaceReader } from "../lib/anchors.mjs";
import { exampleBrief } from "./helpers.mjs";

const lines = (n) => new Array(n).fill("");

test("toLines counts like the extension", () => {
  assert.deepEqual(toLines(""), []);
  assert.deepEqual(toLines("x\ny\n"), ["x", "y"]);
  assert.deepEqual(toLines("x\r\ny"), ["x", "y"]);
  assert.deepEqual(toLines("x\n\n"), ["x", ""]);
});

test("keeps an anchor inside the file", () => {
  const brief = exampleBrief();
  const checked = checkAnchors(brief, () => lines(64));
  assert.deepEqual(checked.items, brief.items);
  assert.equal("droppedAnchors" in checked.meta, false);
});

test("drops an anchor past the end of the file and keeps the item", () => {
  const brief = exampleBrief();
  const checked = checkAnchors(brief, () => lines(60));
  assert.equal(checked.items.length, 2);
  assert.deepEqual(checked.items[0].sourceRefs, [{ path: "src/billing/retry-payment.ts", startLine: 45, endLine: 54 }]);
  assert.deepEqual(checked.items[1].sourceRefs, []);
  assert.deepEqual(checked.meta.droppedAnchors, [
    {
      itemId: "check-retryable-failures",
      path: "src/billing/retry-payment.ts",
      reason: "Lines 55-64 are past the end of the file (60 lines).",
    },
  ]);
});

test("drops an anchor whose file is missing", () => {
  const checked = checkAnchors(exampleBrief(), () => null);
  assert.deepEqual(checked.items.map((i) => i.sourceRefs), [[], []]);
  assert.equal(checked.meta.droppedAnchors.length, 2);
  assert.equal(checked.meta.droppedAnchors[0].reason, "The file does not exist at the brief's head commit.");
});

test("does not change the brief it was given", () => {
  const brief = exampleBrief();
  checkAnchors(brief, () => null);
  assert.deepEqual(brief, exampleBrief());
});

test("workspaceReader refuses paths outside the root", () => {
  const parent = mkdtempSync(join(tmpdir(), "crc-anchors-"));
  try {
    const root = join(parent, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "x\ny\n");
    writeFileSync(join(parent, "secret.txt"), "s\n");
    const read = workspaceReader(root);
    assert.deepEqual(read("a.txt"), ["x", "y"]);
    assert.equal(read("../secret.txt"), null);
    assert.equal(read("../" + basename(root) + "/a.txt"), null);
    assert.equal(read("../../etc/passwd"), null);
    assert.equal(read("/etc/passwd"), null);
    assert.equal(read(join(root, "a.txt")), null);
    assert.equal(read("missing.txt"), null);
    assert.equal(read("."), null);
    assert.equal(read("src"), null);
    // A link inside the repository that points outside it must not be read either.
    symlinkSync(join(parent, "secret.txt"), join(root, "link.txt"));
    symlinkSync(parent, join(root, "linkdir"));
    symlinkSync(join(root, "a.txt"), join(root, "inner-link.txt"));
    assert.equal(read("link.txt"), null);
    assert.equal(read("linkdir/secret.txt"), null);
    assert.deepEqual(read("inner-link.txt"), ["x", "y"]);
    assert.equal(read("a.txt\0.md"), null);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
