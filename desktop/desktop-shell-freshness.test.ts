/**
 * Regression tests for the desktop distribution build contract (fix on
 * f5a0a2e): the installer must never be packaged from a STALE compiled
 * desktop shell.
 *
 * The observed defect: package.json "main" is desktop/dist/main.js and
 * electron-builder packages desktop/dist/** — but `desktop:dist` only ran
 * prepare-server + electron-builder, never `desktop:compile`. The installed
 * Windows app therefore executed the PREVIOUS commit's acceptance contract
 * while the source battery (593/593) proved the new one.
 *
 * Guards enforced here:
 *   1. `npm run desktop:dist` chains desktop:compile BEFORE prepare-server
 *      and the electron-builder script (structural, package.json).
 *   2. scripts/desktop-dist.mjs runs the freshness preflight, so even a
 *      DIRECT invocation cannot package a stale shell (structural).
 *   3. The freshness decision itself: fresh shell passes; a source newer
 *      than the newest compiled output fails LOUDLY naming the file; an
 *      uncompiled tree fails with the compile instruction (functional).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareFreshness, verifyDesktopShellFreshness } from "../scripts/lib/desktop-shell-freshness.mjs";

const here = path.dirname(process.argv[1] ?? ".");
const repoRoot = path.resolve(here, "..");

test("build contract: desktop:dist compiles the shell BEFORE prepare-server and electron-builder", () => {
  const scripts = JSON.parse(readText(path.join(repoRoot, "package.json"))).scripts;
  const dist = scripts["desktop:dist"];
  assert.ok(typeof dist === "string" && dist.length > 0, "desktop:dist must exist");
  const compile = dist.indexOf("npm run desktop:compile");
  const prepare = dist.indexOf("npm run desktop:prepare-server");
  const distScript = dist.indexOf("scripts/desktop-dist.mjs");
  assert.ok(compile !== -1, "desktop:dist must run desktop:compile");
  assert.ok(prepare !== -1, "desktop:dist must run desktop:prepare-server");
  assert.ok(distScript !== -1, "desktop:dist must run the electron-builder script");
  assert.ok(compile < prepare && prepare < distScript, `compile → prepare-server → builder order required, got: ${dist}`);
});

test("build contract: the dist script preflights shell freshness (direct invocations are guarded too)", () => {
  const distScript = readText(path.join(repoRoot, "scripts", "desktop-dist.mjs"));
  assert.ok(
    distScript.includes("verifyDesktopShellFreshness(root)"),
    "desktop-dist.mjs must verify the compiled shell against the current source before packaging",
  );
  assert.ok(
    /if \(!shellFreshness\.ok\) \{[\s\S]*?process\.exit\(1\)/.test(distScript),
    "a stale shell must be a hard, loud failure — never packaged",
  );
});

test("freshness: a compiled shell newer than every source passes", () => {
  const verdict = compareFreshness({
    sources: [{ file: "desktop/main.ts", mtimeMs: 1_000 }, { file: "desktop/acceptance.ts", mtimeMs: 2_000 }],
    outputs: [{ file: "desktop/dist/main.js", mtimeMs: 3_000 }],
  });
  assert.equal(verdict.ok, true);
});

test("freshness: a source newer than the newest compiled output fails LOUDLY, naming a file", () => {
  const verdict = compareFreshness({
    sources: [
      { file: "desktop/main.ts", mtimeMs: 1_000 },
      { file: "desktop/acceptance.ts", mtimeMs: 9_000 }, // edited after the last compile
    ],
    outputs: [{ file: "desktop/dist/main.js", mtimeMs: 3_000 }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /stale/);
  assert.match(verdict.reason, /npm run desktop:compile/);
  assert.match(verdict.reason, /acceptance\.ts/);
  assert.deepEqual(verdict.staleSources, ["desktop/acceptance.ts"]);
});

test("freshness: an uncompiled tree fails with the compile instruction", () => {
  const verdict = compareFreshness({
    sources: [{ file: "desktop/main.ts", mtimeMs: 1_000 }],
    outputs: [],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not compiled/);
});

test("freshness (repo layout): verifyDesktopShellFreshness detects stale, fresh, and uncompiled trees", () => {
  const base = mkdtempSync(path.join(tmpdir(), "shell-freshness-"));
  try {
    const desktop = path.join(base, "desktop");
    const dist = path.join(desktop, "dist");
    mkdirSync(dist, { recursive: true });
    const sourceFile = path.join(desktop, "acceptance.ts");
    const outputFile = path.join(dist, "acceptance.js");
    writeFileSync(sourceFile, "export {};");
    writeFileSync(outputFile, "module.exports = {};");

    // Uncompiled tree (no dist outputs): the compiled file is removed.
    rmSync(outputFile);
    assert.equal(verifyDesktopShellFreshness(base).ok, false);
    assert.match(verifyDesktopShellFreshness(base).reason, /not compiled/);

    // Fresh compile: output newer than the source.
    writeFileSync(outputFile, "module.exports = {};");
    touch(outputFile, sourceFile, /* outputNewer */ true);
    assert.equal(verifyDesktopShellFreshness(base).ok, true);

    // Stale: source edited after the last compile.
    touch(outputFile, sourceFile, /* outputNewer */ false);
    const stale = verifyDesktopShellFreshness(base);
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /stale/);
    assert.ok(stale.staleSources.some((file) => file === sourceFile));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("freshness (this repo): the compiled shell is current after desktop:compile — or honestly not", () => {
  // In the battery, desktop:compile runs before/around the tests; this test
  // asserts the real repo verdict is DECISIVE either way (never a silent
  // pass) and that a present dist is judged correctly.
  const verdict = verifyDesktopShellFreshness(repoRoot);
  const distExists = existsSync(path.join(repoRoot, "desktop", "dist"));
  if (!distExists) {
    assert.equal(verdict.ok, false, "no compiled shell must be an explicit failure, never a pass");
    assert.match(verdict.reason, /not compiled/);
  } else {
    // With a compiled tree present the verdict must be well-formed; the
    // battery's desktop:compile step keeps it fresh.
    assert.equal(verdict.ok, true, verdict.reason);
  }
});

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Set mtimes: when outputNewer, the output is newer than the source;
 * otherwise the source is newer (the stale condition). */
function touch(outputFile: string, sourceFile: string, outputNewer: boolean): void {
  const earlier = new Date(Date.now() - 60_000);
  const later = new Date();
  utimesSync(sourceFile, outputNewer ? earlier : later, outputNewer ? earlier : later);
  utimesSync(outputFile, outputNewer ? later : earlier, outputNewer ? later : earlier);
}
