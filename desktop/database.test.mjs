import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { migrate, run } from "./database.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test("database command timeout waits for the killed child to close", async () => {
  let closed = false;
  let killed = false;
  await assert.rejects(
    run("initdb.exe", [], {}, 5, () => {
      const child = fakeChild();
      child.kill = () => {
        killed = true;
        setTimeout(() => {
          closed = true;
          child.emit("close", null, "SIGTERM");
        }, 10);
        return true;
      };
      return child;
    }),
    (error) => {
      assert.equal(killed, true, "timeout requests termination");
      assert.equal(closed, true, "timeout is not reported until the child has closed");
      assert.match(error.message, /initdb\.exe timed out/);
      return true;
    },
  );
});

test("database command returns captured output after a clean exit", async () => {
  const output = await run("postgres.exe", [], {}, 100, () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdout.write("postgres ready\n");
      child.emit("close", 0, null);
    });
    return child;
  });
  assert.equal(output, "postgres ready\n");
});

test("database command rejects spawn errors after child cleanup", async () => {
  const spawnError = new Error("binary could not start");
  await assert.rejects(
    run("missing.exe", [], {}, 100, () => {
      const child = fakeChild();
      process.nextTick(() => {
        child.emit("error", spawnError);
        child.emit("close", -1, null);
      });
      return child;
    }),
    (error) => error === spawnError,
  );
});

test(
  "failed update migration rolls back its data and schema changes while retaining prior migrations",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `arena_migration_recovery_${process.pid}_${Date.now()}`;
    const directory = await mkdtemp(path.join(tmpdir(), "arena-migration-recovery-"));
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let connected = false;
    let schemaCreated = false;
    try {
      await mkdir(path.join(directory, "migrations"));
      await writeFile(
        path.join(directory, "migrations", "0001_safe.sql"),
        "ALTER TABLE arena_data ADD COLUMN migration_marker text NOT NULL DEFAULT 'safe';",
      );
      await writeFile(
        path.join(directory, "migrations", "0002_fails_after_changes.sql"),
        [
          "DELETE FROM arena_data;",
          "--> statement-breakpoint",
          "ALTER TABLE arena_data DROP COLUMN content;",
          "--> statement-breakpoint",
          "CREATE TABLE partial_migration (id integer);",
          "--> statement-breakpoint",
          "SELECT * FROM missing_migration_table;",
        ].join("\n"),
      );

      await client.connect();
      connected = true;
      await client.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("CREATE TABLE arena_data (id integer PRIMARY KEY, content text NOT NULL)");
      await client.query("INSERT INTO arena_data (id, content) VALUES (1, 'keep this record')");

      await assert.rejects(
        migrate(client, path.join(directory, "migrations")),
        /Migration 0002_fails_after_changes\.sql failed; its uncommitted changes were rolled back/,
      );

      const records = await client.query(
        "SELECT id, content, migration_marker FROM arena_data ORDER BY id",
      );
      assert.deepEqual(records.rows, [
        { id: 1, content: "keep this record", migration_marker: "safe" },
      ]);
      const migrations = await client.query(
        "SELECT name FROM arena_schema_migrations ORDER BY name",
      );
      assert.deepEqual(migrations.rows.map(row => row.name), ["0001_safe.sql"]);
      const partialTable = await client.query(
        "SELECT to_regclass('partial_migration') IS NOT NULL AS exists",
      );
      assert.equal(partialTable.rows[0].exists, false);
    } finally {
      if (connected && schemaCreated) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      }
      if (connected) await client.end().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);
