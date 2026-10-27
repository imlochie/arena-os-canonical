/**
 * Regression test: the packaged server must survive electron-builder's
 * extraResources copy WITH its traced runtime (node_modules/next et al).
 *
 * Defect class (proven on the real Windows install of Arena 0.1.0):
 * electron-builder's copyFiles filter PRUNES any `node_modules` directory
 * that sits directly at the ROOT of an extraResources source
 * (app-builder-lib util/filter.js: relative === "node_modules" → false,
 * and builder-util's walk() applies the filter to directories, pruning
 * the whole subtree). With the single `from: desktop-package/server`
 * entry, resources/app/server shipped server.js but NO node_modules —
 * the installed app died on every launch with
 *   "Cannot find module 'next'" (require stack: server.js)
 * because the generated standalone server.js requires 'next' bare.
 *
 * This test runs electron-builder's REAL FileMatcher + copyFiles (the
 * exact code path platformPackager.js uses for extraResources) against
 * the REAL electron-builder.yml — every from/to entry is parsed from the
 * committed config and applied to a fixture tree — then asserts the
 * copied package contains the server and its runtime deps. It fails if
 * the config ever regresses to a form that lets the node_modules filter
 * prune the server runtime again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..");

/** Minimal shapes of electron-builder internals this test drives for real. */
interface FileMatcherConstructor {
  new (
    from: string,
    to: string,
    macroExpander: (pattern: string) => string,
    patterns: string[],
  ): unknown;
}
interface CopyFiles {
  (matchers: unknown[]): Promise<void>;
}

interface ExtraResourceEntry {
  from: string;
  to: string;
  filter?: string[];
}
interface BuilderConfig {
  extraResources?: ExtraResourceEntry[];
}

const nodeRequire = createRequire(path.join(repoRoot, "package.json"));
const { FileMatcher, copyFiles } = nodeRequire("app-builder-lib/out/fileMatcher") as {
  FileMatcher: FileMatcherConstructor;
  copyFiles: CopyFiles;
};
const { load: loadYaml } = nodeRequire("js-yaml") as { load: (text: string) => BuilderConfig };

test("extraResources copy ships the standalone server with its node_modules runtime", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "arena-eb-src-"));
  const destRoot = mkdtempSync(path.join(tmpdir(), "arena-eb-dest-"));
  try {
    // Fixture mirroring the staged desktop-package layout (shape, not size).
    const put = (relative: string, content: string): void => {
      mkdirSync(path.dirname(path.join(fixtureRoot, relative)), { recursive: true });
      writeFileSync(path.join(fixtureRoot, relative), content);
    };
    put("desktop-package/server/server.js", "require('next')");
    put("desktop-package/server/package.json", '{"name":"arena-server"}');
    put("desktop-package/server/.next/static/app.css", "body{}");
    put("desktop-package/server/node_modules/next/package.json", '{"name":"next"}');
    put("desktop-package/server/node_modules/next/dist/server.js", "// next runtime");
    put("desktop-package/server/node_modules/pg/package.json", '{"name":"pg"}');
    put("desktop-package/server/node_modules/pg/lib/index.js", "// pg");
    // Stubs so every OTHER extraResources source also exists.
    put("desktop-package/bin/ffmpeg.exe", "");
    put("desktop-package/desktop-migrations/0001_init.sql", "--");
    put("desktop-package/embedded-postgres/bin/postgres.exe", "");
    put("desktop/build/licenses/FFMPEG-LICENSE.txt", "GPL");

    const config = loadYaml(readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8"));
    const entries = config.extraResources ?? [];
    assert.ok(entries.length > 0, "electron-builder.yml must define extraResources");

    // Mirror app-builder-lib's getFileMatchers for object entries:
    // `from` resolves against the project dir, `to` against the resources
    // dir, patterns come from entry.filter. copyFiles then does exactly
    // what the real Windows build does (platformPackager.js → copyFiles).
    const matchers = entries.map(
      (entry) =>
        new FileMatcher(
          path.resolve(fixtureRoot, entry.from),
          path.resolve(destRoot, entry.to),
          (pattern) => pattern,
          entry.filter ?? [],
        ),
    );
    await copyFiles(matchers);

    const shipped = (relative: string): boolean => existsSync(path.join(destRoot, relative));
    // The server itself ships.
    assert.ok(shipped("app/server/server.js"), "server.js must land in app/server");
    assert.ok(shipped("app/server/.next/static/app.css"), "static assets must ship inside the server tree");
    // …WITH its traced runtime. This is the exact pruning defect that
    // broke the installed Windows app: a `node_modules` child at the root
    // of an extraResources source is dropped by electron-builder's filter.
    assert.ok(
      shipped("app/server/node_modules/next/package.json"),
      "node_modules/next must ship beside server.js — electron-builder prunes node_modules at the copy root (see the dedicated extraResources entry)",
    );
    assert.ok(shipped("app/server/node_modules/next/dist/server.js"), "next/dist must be complete");
    assert.ok(shipped("app/server/node_modules/pg/package.json"), "traced server-external deps (pg) must ship");
    // The rest of the package layout is unaffected.
    assert.ok(shipped("app/bin/ffmpeg.exe"), "ffmpeg must ship in app/bin");
    assert.ok(shipped("app/desktop-migrations/0001_init.sql"), "migrations must ship in app/desktop-migrations");
    assert.ok(shipped("app/embedded-postgres/bin/postgres.exe"), "embedded PostgreSQL must ship");
    assert.ok(shipped("licenses/FFMPEG-LICENSE.txt"), "the GPL license notice must ship in licenses/");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
  }
});
