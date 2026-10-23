import { mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations } from "../../desktop/runtime/migrate";
import { postgresPathDirs } from "../../desktop/runtime/config";
export async function missionPostgres() {
  const root = await mkdtemp(path.join(tmpdir(), "arena-mission-recovery-"));
  let pg: ReturnType<typeof spawn> | undefined;
  let pool: Pool | undefined;
  let diagnostics = "";
  const bin = path.resolve(`node_modules/@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}/native/bin`);
  const exe = (name: string) => path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  // Windows loads PostgreSQL's DLLs from the package's bin/ and lib/ via PATH;
  // the product resolver derives exactly this list (desktop/runtime/config.ts).
  const pathDirs = postgresPathDirs(process.platform, path.dirname(bin));
  const childEnv = pathDirs.length === 0
    ? process.env
    : { ...process.env, PATH: `${pathDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}` };
  const launch = (args: string[]) => {
    const child = spawn(exe("postgres"), args, { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
    child.stderr?.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
    child.on("error", error => { diagnostics += String(error); });
    return child;
  };
  try {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve()));
  const init = spawnSync(exe("initdb"), ["-D", path.join(root, "data"), "-U", "postgres", "--auth=trust", "--locale=C"], { encoding: "utf8", env: childEnv });
  if (init.status !== 0) throw new Error(`initdb: ${init.stderr}`);
  pg = launch(["-D", path.join(root, "data"), "-p", String(port), "-h", "127.0.0.1", ...(process.platform === "win32" ? [] : ["-k", root])]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const { waitForPostgresReady } = await import("../../src/lib/waveyard/library/pg-readiness");
  await waitForPostgresReady({ createClient: () => new Client(url), useConnectedClient: async () => {} });
  pool = new Pool({ connectionString: url });
  pool.on("error", () => { /* outage fixtures deliberately terminate idle clients */ });
  const client = await pool.connect();
  try { await applyMigrations({ client: client as never, migrationsDir: path.resolve("desktop-migrations") }); } finally { client.release(); }
  const ownedPool = pool;
  return { url, pool,
    async stop() { const stopped = spawnSync(exe("pg_ctl"), ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"], { encoding: "utf8", env: childEnv }); if (stopped.status !== 0) throw new Error(stopped.stderr); },
    async start() { pg = launch(["-D", path.join(root, "data"), "-p", String(port), "-h", "127.0.0.1", ...(process.platform === "win32" ? [] : ["-k", root])]); await waitForPostgresReady({ createClient: () => new Client(url), useConnectedClient: async () => {} }); },
    database: drizzle(pool) as unknown as typeof import("../../src/db").db,
    async close() { await ownedPool.end(); spawnSync(exe("pg_ctl"), ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"], { stdio: "ignore", env: childEnv }); if (pg && pg.exitCode === null) pg.kill(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await pool?.end();
    spawnSync(exe("pg_ctl"), ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: childEnv });
    pg?.kill();
    await rm(root, { recursive: true, force: true });
    throw new Error(`Test PostgreSQL failed: ${String(error)}\n${diagnostics}`);
  }
}
