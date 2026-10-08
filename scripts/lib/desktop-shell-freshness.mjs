/**
 * Compiled-shell freshness for the desktop distribution (build-contract fix
 * on f5a0a2e).
 *
 * Defect: package.json "main" is desktop/dist/main.js and electron-builder
 * packages desktop/dist/**, but `desktop:dist` never ran `desktop:compile`
 * — so the installer could be built from STALE compiled shell JavaScript
 * while the TypeScript source (and the whole test battery) was current.
 * The Windows acceptance then executed the previous commit's acceptance
 * contract from the installed app.
 *
 * Contract (regression-tested in desktop/desktop-shell-freshness.test.ts):
 *   - `desktop:dist` runs desktop:compile FIRST (package.json script chain);
 *   - scripts/desktop-dist.mjs additionally verifies, at preflight, that the
 *     compiled desktop/dist is not older than the current desktop/*.ts
 *     sources (or tsconfig) — a direct invocation of the dist script can
 *     never package a stale shell either;
 *   - staleness fails LOUDLY with the fix instruction; nothing is rebuilt
 *     silently.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Pure freshness decision over observed mtimes — fully testable without
 * touching the real repo layout. */
export function compareFreshness(input) {
  const { sources, outputs } = input;
  if (outputs.length === 0) {
    return {
      ok: false,
      reason: "desktop/dist is not compiled — run: npm run desktop:compile",
      staleSources: sources.map((entry) => entry.file),
    };
  }
  const newestOutputMs = Math.max(...outputs.map((entry) => entry.mtimeMs));
  const staleSources = sources.filter((entry) => entry.mtimeMs > newestOutputMs);
  if (staleSources.length > 0) {
    return {
      ok: false,
      reason:
        `the compiled desktop shell is stale — ${staleSources.length} source file(s) are newer than desktop/dist ` +
        `(newest: ${path.basename(staleSources[0].file)}) — run: npm run desktop:compile`,
      staleSources: staleSources.map((entry) => entry.file),
    };
  }
  return { ok: true, reason: "compiled desktop shell is current", staleSources: [] };
}

function walkFiles(dir, filter, into) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filter, into);
    else if (filter(full)) into.push(full);
  }
}

/** Verify the repo's compiled desktop shell against its TypeScript sources
 * (desktop/*.ts at any depth + desktop/tsconfig.json). */
export function verifyDesktopShellFreshness(root) {
  const desktopDir = path.join(root, "desktop");
  const distDir = path.join(desktopDir, "dist");
  const sources = [];
  walkFiles(desktopDir, (file) => /\.(ts|tsx)$/.test(file) && !file.startsWith(distDir + path.sep), sources);
  const tsconfig = path.join(desktopDir, "tsconfig.json");
  if (existsSync(tsconfig)) sources.push(tsconfig);
  if (sources.length === 0) {
    return { ok: false, reason: "no desktop TypeScript sources found — wrong root?", staleSources: [] };
  }
  const outputs = [];
  walkFiles(distDir, (file) => /\.js$/.test(file), outputs);
  return compareFreshness({
    sources: sources.map((file) => ({ file, mtimeMs: statSync(file).mtimeMs })),
    outputs: outputs.map((file) => ({ file, mtimeMs: statSync(file).mtimeMs })),
  });
}
