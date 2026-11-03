import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// This is a host-independent API contract check, NOT Windows acceptance.
test("native API serves the built SPA, blocks cross-site reads and shuts down through IPC", { skip: !process.env.DATABASE_URL }, async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const root = await mkdtemp(path.join(tmpdir(), "arena-native-api-contract-"));
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>Native Vite contract</title>");
  const script = fileURLToPath(new URL("../artifacts/api-server/dist/index.mjs", import.meta.url));
  const schema = `arena_native_contract_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`create schema "${schema}"`);
  await admin.query(`create table "${schema}".space_missions (status text, status_detail text, updated_at timestamptz)`);
  await admin.query(`create table "${schema}".processing_jobs (id text, type text, status text, stage text, error_code text, error_message text, completed_at timestamptz, updated_at timestamptz)`);
  await admin.query(`create table "${schema}".source_assets (storage_key text)`);
  await admin.query(`create table "${schema}".waveform_assets (storage_key text)`);
  await admin.query(`create table "${schema}".waveform_jobs (
    id uuid,
    project_id uuid,
    source_asset_id uuid,
    stem_asset_id uuid,
    status text,
    stage text,
    attempts integer,
    idempotency_key text,
    error_code text,
    error_message text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
  )`);
  // API startup recovers interrupted conversion jobs and immediately drains
  // the queue, so the contract schema needs the worker's startup/query columns.
  await admin.query(`create table "${schema}".wy_library_conversion_jobs (
    id uuid,
    status text,
    stage text,
    progress integer,
    attempts integer,
    error_message text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
  )`);
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema}`, NODE_ENV: "production", PORT: String(port), ARENA_DESKTOP_MODE: "1", ARENA_DATA_DIR: root, ARENA_WEB_ROOT: web },
  });
  let log = "";
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-4000); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      assert.equal(child.exitCode, null, log);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).ok) { healthy = true; break; }
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(healthy, log);
    assert.match(await (await fetch(`${base}/spaces`)).text(), /Native Vite contract/);
    assert.equal((await fetch(`${base}/api/spaces`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(`${base}/api/spaces`, { headers: { Origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/health`, { headers: { "X-Forwarded-Host": "untrusted.example" } })).status, 200);
    child.send("shutdown");
    const exitCode = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve("timeout"), 15_000))]);
    assert.equal(exitCode, 0, log);
  } finally {
    if (child.exitCode === null) child.kill();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
