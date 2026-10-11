/**
 * staged-tree-guard tests — regression for the recursive self-packaging
 * defect (a previous desktop-release/win-unpacked traced into the staged
 * server and shipped inside the next installer):
 *   - build-output directories are rejected at ANY depth
 *   - the packaged-app layout (resources/app) is rejected
 *   - clean trees pass, and legitimately-named files are NOT flagged
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertStagedTreeClean, findPackagingContamination } from "../scripts/lib/staged-tree-guard.mjs";

function makeTree(build: (dir: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "arena-guard-"));
  build(root);
  return root;
}

test("a clean staged tree passes with no violations", () => {
  const root = makeTree((dir) => {
    mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "next"), { recursive: true });
    writeFileSync(path.join(dir, "server.js"), "ok");
  });
  try {
    assert.deepEqual(findPackagingContamination(root), []);
    assert.doesNotThrow(() => assertStagedTreeClean(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a desktop-release directory is rejected at ANY depth (the real defect shape)", () => {
  const root = makeTree((dir) => {
    mkdirSync(path.join(dir, "server", "desktop-release", "win-unpacked", "resources", "app", "bin"), { recursive: true });
    writeFileSync(path.join(dir, "server", "desktop-release", "win-unpacked", "resources", "app", "bin", "ffmpeg.exe"), "x");
  });
  try {
    const violations = findPackagingContamination(root);
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /desktop-release/);
    assert.throws(() => assertStagedTreeClean(root), /recursive self-packaging guard/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop-package, win-unpacked and sibling unpacked layouts are rejected", () => {
  for (const name of ["desktop-package", "win-unpacked", "linux-unpacked", "mac-unpacked"]) {
    const root = makeTree((dir) => {
      mkdirSync(path.join(dir, "deeply", "nested", name), { recursive: true });
    });
    try {
      const violations = findPackagingContamination(root);
      assert.equal(violations.length, 1, `${name} must be flagged`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a nested packaged-app layout (resources/app) is rejected", () => {
  const root = makeTree((dir) => {
    mkdirSync(path.join(dir, "server", "resources", "app", "embedded-postgres"), { recursive: true });
  });
  try {
    assert.equal(findPackagingContamination(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legitimately-named files are NOT flagged (no false positives)", () => {
  const root = makeTree((dir) => {
    mkdirSync(path.join(dir, "docs", "release-notes"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "release-notes", "desktop-release-notes.txt"), "not packaging output");
    mkdirSync(path.join(dir, "src", "app-resources"), { recursive: true });
    writeFileSync(path.join(dir, "src", "app-resources", "app.ts"), "x");
  });
  try {
    assert.deepEqual(findPackagingContamination(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
