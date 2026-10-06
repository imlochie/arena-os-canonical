/**
 * One-command local database setup:
 *
 *   npm run db:setup
 *
 * 1. Loads DATABASE_URL from .env (creating nothing — run `npm run dev`
 *    once, or `copy .env.example .env`, if .env is absent).
 * 2. Connects to the server's maintenance database and creates the
 *    target database if it does not exist.
 * 3. Applies the schema with drizzle-kit push.
 *
 * Fails with plain-language causes: PostgreSQL not running, wrong
 * credentials in .env, or unreachable host.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error(
    "[db] DATABASE_URL is not set. Copy .env.example to .env (or run npm run dev once) and retry.",
  );
  process.exit(1);
}

let target;
try {
  target = new URL(rawUrl);
} catch {
  console.error(`[db] DATABASE_URL is not a valid URL: ${rawUrl}`);
  process.exit(1);
}

const databaseName = decodeURIComponent(target.pathname.replace(/^\//, "")) || "app_db";
const connection = {
  host: target.hostname || "127.0.0.1",
  port: Number(target.port || 5432),
  user: decodeURIComponent(target.username || "postgres"),
  password: decodeURIComponent(target.password || ""),
};

const { Client } = await import("pg");
const admin = new Client({ ...connection, database: "postgres" });

try {
  await admin.connect();
} catch (error) {
  console.error(`[db] Could not reach PostgreSQL at ${connection.host}:${connection.port}: ${error.message}`);
  console.error("[db] Likely causes:");
  console.error("[db]   - PostgreSQL is not running (start the service / Docker container)");
  console.error("[db]   - The username/password in .env do not match your local PostgreSQL");
  console.error("[db]   - The port in .env is wrong");
  process.exit(1);
}

try {
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    console.log(`[db] Created database "${databaseName}".`);
  } else {
    console.log(`[db] Database "${databaseName}" already exists.`);
  }
} finally {
  await admin.end();
}

console.log("[db] Applying schema (drizzle-kit push)…");
const result = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
  cwd: root,
});
process.exit(result.status ?? 1);
