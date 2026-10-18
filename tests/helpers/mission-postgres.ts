import { mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../../desktop/runtime/migrate";
export async function missionPostgres() {
  const root = await mkdtemp(path.join(tmpdir(), "arena-mission-recovery-"));
  const bin = path.resolve(`node_modules/@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}/native/bin`);
  const exe = (name: string) => path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve()));
  const init = spawnSync(exe("initdb"), ["-D", path.join(root, "data"), "-U", "postgres", "--auth=trust", "--locale=C"], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`initdb: ${init.stderr}`);
  let pg = spawn(exe("postgres"), ["-D", path.join(root, "data"), "-p", String(port), "-h", "127.0.0.1", ...(process.platform === "win32" ? [] : ["-k", root])], { stdio: "ignore" });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const { waitForPostgresReady } = await import("../../src/lib/waveyard/library/pg-readiness");
  await waitForPostgresReady({ createClient: () => new Client(url), useConnectedClient: async () => {} });
  const pool = new Pool({ connectionString: url });
  pool.on("error", () => { /* outage fixtures deliberately terminate idle clients */ });
  const client = await pool.connect();
  try { await applyMigrations({ client: client as never, migrationsDir: path.resolve("desktop-migrations") }); } finally { client.release(); }
  return { url, pool,
    async stop() { const stopped = spawnSync(exe("pg_ctl"), ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"], { encoding: "utf8" }); if (stopped.status !== 0) throw new Error(stopped.stderr); },
    async start() { pg = spawn(exe("postgres"), ["-D", path.join(root, "data"), "-p", String(port), "-h", "127.0.0.1", ...(process.platform === "win32" ? [] : ["-k", root])], { stdio: "ignore" }); await waitForPostgresReady({ createClient: () => new Client(url), useConnectedClient: async () => {} }); },
    database: drizzle(pool) as unknown as typeof import("../../src/db").db,
    async close() { await pool.end(); spawnSync(exe("pg_ctl"), ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"], { stdio: "ignore" }); if (pg.exitCode === null) pg.kill(); await rm(root, { recursive: true, force: true }); } };
}
