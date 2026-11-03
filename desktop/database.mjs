/**
 * Current-runtime extraction of the original desktop database lifecycle.
 * Preserve existing clusters; initialise only an empty directory; run ordered
 * SQL migrations transactionally; stop with pg_ctl, never delete on failure.
 */
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function run(binary, args, env, timeout = 60_000, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let spawnError;
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-6000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-6000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (error) { spawnError = error; }
    }, timeout);
    child.once("error", error => { spawnError = error; });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${path.basename(binary)} timed out${output ? `: ${output}` : ""}`, { cause: spawnError }));
      } else if (spawnError) {
        reject(spawnError);
      } else if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${path.basename(binary)} failed (${code}): ${output}`));
      }
    });
  });
}

export async function migrate(client, directory) {
  await client.query("create table if not exists arena_schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await client.query("select name from arena_schema_migrations")).rows.map(row => row.name));
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  if (!files.length) throw new Error("Desktop migrations are missing");
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query("begin");
    let commitAttempted = false;
    try {
      const sql = await readFile(path.join(directory, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
        await client.query(statement);
      }
      await client.query("insert into arena_schema_migrations (name) values ($1)", [file]);
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      let rollbackError;
      try {
        await client.query("rollback");
      } catch (failure) {
        rollbackError = failure;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackError) {
        throw new Error(
          `Migration ${file} failed and rollback could not be confirmed. Do not reset or delete Arena data before recovery. ${message}`,
          { cause: new AggregateError([error, rollbackError], "Migration and rollback both failed.") },
        );
      }
      if (commitAttempted) {
        throw new Error(
          `Migration ${file} failed while committing; its final status could not be confirmed. Keep Arena data intact and inspect migration status before retrying. ${message}`,
          { cause: error },
        );
      }
      throw new Error(
        `Migration ${file} failed; its uncommitted changes were rolled back and existing data was retained: ${message}`,
        { cause: error },
      );
    }
  }
}

export class DesktopDatabase {
  constructor({ resources, root, port, password, log }) {
    this.root = root;
    this.port = port;
    this.password = password;
    this.resources = resources;
    this.log = log;
    this.dir = path.join(root, "data/postgres");
    this.bin = path.join(resources, "embedded-postgres/bin");
    this.env = { ...process.env, PATH: `${this.bin}${path.delimiter}${path.join(resources, "embedded-postgres/lib")}${path.delimiter}${process.env.PATH || ""}` };
    this.config = { host: "127.0.0.1", port, user: "arena", password, connectionTimeoutMillis: 2500 };
    this.child = null;
    this.stopping = false;
  }

  async start() {
    const versionOutput = await run(path.join(this.bin, "postgres.exe"), ["--version"], this.env);
    const major = versionOutput.match(/\(PostgreSQL\)\s+(\d+)/)?.[1];
    if (!major) throw new Error("Bundled PostgreSQL version could not be verified");
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir);
    if (entries.length) {
      let version;
      try { version = (await readFile(path.join(this.dir, "PG_VERSION"), "utf8")).trim(); }
      catch { throw new Error("Existing database is missing PG_VERSION. It was NOT deleted or reinitialised."); }
      if (version !== major) throw new Error(`Existing database uses PostgreSQL ${version}; this package has ${major}. Use the matching Arena build or migrate a backup with pg_upgrade. Data was NOT changed.`);
      // Never remove a pid file here: PostgreSQL decides whether crash recovery
      // is safe and refuses a live cluster. A conflicting instance must stop.
    } else {
      const pwFile = path.join(this.root, "runtime/initdb-password");
      await writeFile(pwFile, this.password, { mode: 0o600, flag: "wx" });
      try {
        await run(path.join(this.bin, "initdb.exe"), [
          "-D", this.dir, "-U", "arena", "--pwfile", pwFile,
          "-E", "UTF8", "--locale", "C", "-A", "scram-sha-256",
        ], this.env);
      } finally { await rm(pwFile, { force: true }); }
    }
    this.child = spawn(path.join(this.bin, "postgres.exe"), [
      "-D", this.dir, "-p", String(this.port), "-h", "127.0.0.1",
    ], { env: this.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.on("data", chunk => this.log("database", String(chunk)));
    this.child.stderr.on("data", chunk => this.log("database", String(chunk)));
    this.child.on("error", error => { this.failure = error.message; });
    this.child.on("exit", code => { if (!this.stopping) this.failure = `PostgreSQL exited (${code})`; });
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (this.failure) throw new Error(this.failure);
      const client = new pg.Client({ ...this.config, database: "postgres" });
      try { await client.connect(); ready = true; break; }
      catch { await pause(300); }
      finally { await client.end().catch(() => {}); }
    }
    if (!ready) throw new Error("Local database did not become ready; check the desktop log");
    const admin = new pg.Client({ ...this.config, database: "postgres" });
    await admin.connect();
    try {
      if (!(await admin.query("select 1 from pg_database where datname='arena'")).rowCount) {
        await admin.query('create database "arena"');
      }
    } finally { await admin.end(); }
    const client = new pg.Client({ ...this.config, database: "arena" });
    await client.connect();
    try { await migrate(client, path.join(this.resources, "desktop-migrations")); }
    finally { await client.end(); }
  }

  async stop() {
    this.stopping = true;
    if (!this.child) return;
    if (this.child.exitCode !== null) return;
    // On Windows SIGTERM is TerminateProcess. pg_ctl allows a real clean stop.
    await run(path.join(this.bin, "pg_ctl.exe"), ["-D", this.dir, "-m", "fast", "-w", "-t", "20", "stop"], this.env, 25_000);
    await access(path.join(this.dir, "postmaster.pid"))
      .then(() => { throw new Error("PostgreSQL did not release its data directory"); }, () => {});
    this.child = null;
  }
}
