/**
 * Regression tests for Windows-safe repo-root resolution.
 *
 * The original bug: scripts/windows-acceptance.mjs derived its root from
 * `new URL(import.meta.url).pathname`, which on Windows produces
 * `/C:/Projects/...` — combined with path.resolve this yielded the doubly
 * driven `C:\C:\Projects\arena-os-canonical\...` report path. These tests
 * pin the correct behaviour: fileURLToPath, no percent-encoding leaks, no
 * leading slash before a drive letter, and a real child process resolving
 * from a directory containing spaces.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { repoRootFromMeta } from "../scripts/lib/repo-root.mjs";

const rootScriptsLib = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "scripts", "lib");

test("repoRootFromMeta resolves this test file's own URL to the repo root", () => {
  // Under `node --test`, process.argv[1] IS this test file — a module-system
  // agnostic way to get our own path (no import.meta / __filename).
  const root = repoRootFromMeta(pathToFileURL(process.argv[1]).href);
  assert.ok(path.isAbsolute(root), "absolute");
  assert.equal(path.basename(root), "arena-os-canonical");
  assert.ok(existsSync(path.join(root, "package.json")), "resolves to the real repo root");
});

test("no doubled drive letter and no percent-encoding leaks for Windows-style URLs", () => {
  const root = repoRootFromMeta("file:///C:/Projects/arena%20os/scripts/probe.mjs");
  // win32: C:\Projects\arena os — POSIX: /C:/Projects/arena os. Both are
  // valid paths for their platform; what must NEVER happen is the raw
  // URL.pathname shape: a leading "/C:\" fragment or a literal "%20".
  assert.ok(!root.includes("%20"), `percent-encoding must be decoded: ${root}`);
  assert.ok(!root.includes("/C:\\"), `no leading slash before a drive letter: ${root}`);
  assert.ok(root.endsWith(path.join("Projects", "arena os")), `space survives as a real space: ${root}`);
});

test("a child node process resolves its root from a spaced directory (end-to-end)", () => {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), "arena repo root "));
  try {
    // The helper expects to live in <root>/scripts/lib — mirror that layout
    // with a COPY of the real helper (end-to-end: real code, real file URLs).
    const libDir = path.join(fakeRoot, "scripts", "lib");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      path.join(libDir, "repo-root.mjs"),
      readFileSync(path.join(rootScriptsLib, "repo-root.mjs")),
    );
    // A real script at <root>/scripts/probe-main.mjs that imports the copied
    // helper and resolves ITS OWN module URL — exactly what the harness
    // scripts do at runtime.
    const probe = path.join(fakeRoot, "scripts", "probe-main.mjs");
    writeFileSync(
      probe,
      [
        'import { pathToFileURL } from "node:url";',
        'const mod = await import(pathToFileURL(process.argv[2]).href);',
        'process.stdout.write(mod.repoRootFromMeta(import.meta.url));',
        "",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, [probe, path.join(libDir, "repo-root.mjs")], { encoding: "utf8" });
    assert.equal(run.status, 0, `probe exited cleanly: ${run.stderr}`);
    assert.equal(run.stdout, fakeRoot, `child resolved the spaced root exactly: ${run.stdout}`);
    // And the URL the child saw genuinely contained an encoded space:
    assert.ok(pathToFileURL(probe).href.includes("%20"), "the fixture really exercised percent-encoding");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});
