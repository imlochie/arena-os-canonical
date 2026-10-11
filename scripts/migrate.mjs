// ===========================================================================
// PRODUCTION MIGRATION RUNNER
// ===========================================================================
// `drizzle-kit push` diffs a live database and applies whatever it infers.
// That is fine on a laptop and unacceptable in production: it has no record
// of what ran, no ordering guarantee, and it will happily drop a column it
// thinks is redundant. This applies the checked-in SQL files in order, once
// each, inside a transaction, and records what it did.
//
//   node scripts/migrate.mjs
// ===========================================================================

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const dir = path.join(process.cwd(), "drizzle");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
});

await client.connect();
await client.query(`
  create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`);

const done = new Set(
  (await client.query("select name from _migrations")).rows.map((r) => r.name)
);

// BASELINE ADOPTION.
// An existing database that predates this runner has the tables but no
// migration history, so the baseline would fail on "relation already exists".
// Rather than make the baseline destructive or wrap it in IF NOT EXISTS (which
// would silently skip genuinely missing tables on a fresh deploy), detect the
// case explicitly and record the baseline as already satisfied.
if (done.size === 0) {
  const { rows } = await client.query(
    "select count(*)::int n from information_schema.tables where table_schema='public' and table_name like 'college_%'"
  );
  if (rows[0].n > 0) {
    const baseline = files[0];
    await client.query("insert into _migrations (name) values ($1) on conflict do nothing", [baseline]);
    done.add(baseline);
    console.log(`  · ${baseline} (adopted: ${rows[0].n} college tables already present)`);
  }
}

let applied = 0;
for (const file of files) {
  if (done.has(file)) {
    console.log(`  · ${file} (already applied)`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, file), "utf8");
  // Drizzle separates statements with this marker; splitting on semicolons
  // would break any function body or string containing one.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    await client.query("begin");
    for (const stmt of statements) await client.query(stmt);
    await client.query("insert into _migrations (name) values ($1)", [file]);
    await client.query("commit");
    console.log(`  ✓ ${file} (${statements.length} statements)`);
    applied++;
  } catch (e) {
    await client.query("rollback");
    console.error(`  ✗ ${file} rolled back: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(applied ? `\n${applied} migration(s) applied.` : "\nSchema already current.");
await client.end();
