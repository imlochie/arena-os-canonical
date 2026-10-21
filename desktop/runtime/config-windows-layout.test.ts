/**
 * Windows runtime-layout regression.
 *
 * Real Windows defect this locks down: the dev (node_modules) layout built
 * binary paths as "initdb" / "pg_ctl" / "postgres" with no `.exe` suffix and
 * left windowsPathDirs empty, so `npm run desktop` on Windows spawned a path
 * that does not exist (the package ships initdb.exe) and, even if the name had
 * matched, PostgreSQL could not load its DLLs from lib/.
 *
 * The packaged layout had the suffix; the two layouts must agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { postgresBinary, postgresPathDirs, resolveEmbeddedPostgres } from "./config";

function fakeAppRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "arena-pg-layout-"));
  return root;
}

test("win32 dev layout resolves .exe binaries and puts bin+lib on PATH", () => {
  const root = fakeAppRoot();
  try {
    const bin = path.join(root, "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "initdb.exe"), "");

    const layout = resolveEmbeddedPostgres("win32", root);
    assert.ok(layout.initdb.endsWith("initdb.exe"), layout.initdb);
    assert.ok(layout.pgCtl.endsWith("pg_ctl.exe"), layout.pgCtl);
    assert.ok(layout.postgres.endsWith("postgres.exe"), layout.postgres);
    assert.deepEqual(layout.windowsPathDirs, [path.join(layout.nativeDir, "bin"), path.join(layout.nativeDir, "lib")]);
    assert.ok(layout.nativeDir.includes("windows-x64"), layout.nativeDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("win32 packaged layout keeps .exe and PATH dirs", () => {
  const root = fakeAppRoot();
  try {
    const bin = path.join(root, "embedded-postgres", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "postgres.exe"), "");

    const layout = resolveEmbeddedPostgres("win32", root);
    assert.equal(layout.nativeDir, path.join(root, "embedded-postgres"));
    assert.ok(layout.initdb.endsWith("initdb.exe"), layout.initdb);
    assert.deepEqual(layout.windowsPathDirs, [path.join(layout.nativeDir, "bin"), path.join(layout.nativeDir, "lib")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linux/darwin keep bare names and no Windows PATH entries", () => {
  const root = fakeAppRoot();
  try {
    const bin = path.join(root, "node_modules", "@embedded-postgres", "linux-x64", "native", "bin");
    mkdirSync(bin, { recursive: true });

    const layout = resolveEmbeddedPostgres("linux", root);
    assert.equal(path.basename(layout.initdb), "initdb");
    assert.equal(path.basename(layout.pgCtl), "pg_ctl");
    assert.equal(path.basename(layout.postgres), "postgres");
    assert.deepEqual(layout.windowsPathDirs, []);
    assert.deepEqual(postgresPathDirs("darwin", "/x"), []);
    assert.equal(postgresBinary("darwin", "/x/bin", "pg_ctl"), path.join("/x/bin", "pg_ctl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
