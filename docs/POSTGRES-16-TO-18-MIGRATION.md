# Controlled PostgreSQL 16 → 18 Migration Plan

This is the **planned** migration path for moving an Arena data directory
from the pinned PostgreSQL 16 runtime to PostgreSQL 18. It is deliberately
NOT part of immediate recovery (see `POSTGRES-RECOVERY.md`): recovery first
gets the application working on 16 with the original data intact.

**Rule: `pg_upgrade` runs against a COPY of the data directory. The only
original is never upgraded in place.**

## Why this is feasible

- Arena's schema (`desktop-migrations/0000–0015`) uses **no PostgreSQL
  extensions** — core types only (`gen_random_uuid()` is built into core
  since PostgreSQL 13). There is no extension version matrix to resolve.
- Both runtimes come from the same `@embedded-postgres/*` distribution, so
  `initdb`, `pg_ctl`, `pg_upgrade` and `postgres` of both majors share the
  same layout and library handling.
- `pg_upgrade` is the supported major-version upgrade mechanism and keeps
  the data in the new catalog format without dump/restore of the heap.

## Preconditions

1. Arena is running normally on the pinned PostgreSQL 16 build and the
   recovery acceptance has passed (records visible and readable).
2. A verified backup exists and passes re-verification:

   ```bash
   node scripts/pg-backup.mjs "<dataDir>" --out "<backupRoot>"
   node -e "import('./scripts/pg-backup.mjs').then(m => m.verifyBackup('<dest>')).then(r => console.log(r.ok))"
   ```

3. Disk space: roughly the size of the data directory (copy) plus the same
   again for the upgraded cluster. Check before starting.
4. Arena and the embedded server are **stopped** (no `postmaster.pid`
   process alive).

## Binary locations

| Install type | 16.x binaries | 18.x binaries |
| --- | --- | --- |
| Dev checkout | `node_modules/@embedded-postgres/<platform>-x64/native/bin` (pinned `16.14.0-beta.17`) | a separate install of `@embedded-postgres/<platform>-x64@18.4.0-beta.17` (e.g. `npm install @embedded-postgres/linux-x64@18.4.0-beta.17 --prefix /tmp/pg18`) |
| Packaged desktop | `resources/app/embedded-postgres/bin` | same layout from a package built with the 18.x pin |

Never mix binaries from different platforms or from a `PATH`-installed
system PostgreSQL. Both binaries are executed with the package's `lib` on
`LD_LIBRARY_PATH` (POSIX) / `PATH` (Windows), exactly as the app does.

## Procedure (on a copy)

Notation: `<data16>` = the verified backup copy of the PG 16 data
directory (NOT the live original), `<data18>` = a new empty directory,
`<bin16>`/`<bin18>` = the `bin` directories above.

```bash
# 0. Work on a copy; the original stays untouched.
cp -a "<backupDest>" "<work>/data16"

# 1. New empty target and a dedicated superuser role for the upgrade.
<bin18>/initdb -D "<data18>" -U arena --pwfile <pwfile> -E UTF8 --locale C -A scram-sha-256

# 2. Run pg_upgrade with both binary sets.
<bin18>/pg_upgrade \
  --old-datadir="<work>/data16" --new-datadir="<work>/data18" \
  --old-bindir="<bin16>"       --new-bindir="<bin18>"

# 3. Start the NEW cluster and verify data integrity.
<bin18>/pg_ctl -D "<data18>" -o "-p 55432 -h 127.0.0.1" -l "<work>/pg18.log" start
```

Verification queries (psql or any client against port 55432):

```sql
select count(*) from arena_schema_migrations;   -- 0000..0015 present
select count(*) from projects;                   -- matches pre-migration count
select count(*) from processing_jobs;            -- matches pre-migration count
select count(*) from archive_items;              -- matches pre-migration count
```

Take the row counts **before** the upgrade (against the PG 16 copy) and
compare. Then run the application migrations on the upgraded cluster
(`desktop/runtime/migrate.ts` path, or start the desktop app once) and
confirm `arena_schema_migrations` reports no pending files.

## Application acceptance

1. Point a test/dev Arena at the upgraded cluster
   (`DATABASE_URL=postgres://…@127.0.0.1:55432/arena`).
2. Read back representative records in Projects, Waveyard library,
   Sessions and Arcade.
3. Write and re-read a new record in each — the write path exercises
   `gen_random_uuid()` defaults and timestamps.
4. Only then plan the switch: stop the app, move the PG 16 directory to
   `postgres-pre18-<date>`, move `<data18>` into place, start the shipped
   build (which will report PostgreSQL 18 in
   `desktop/runtime/embedded-postgres.ts` logs and in `pg --version`).

## Rollback

- The switch keeps the PG 16 directory as `postgres-pre18-<date>`; move it
  back and run the pinned PG 16 build at any time.
- If the upgrade failed midway, discard `<work>/data18` entirely — the
  backup copy and the original are both untouched.
- `pg_upgrade` leaves `delete_old_cluster.sh` in the new directory. **Do
  not run it** until the new cluster has been in production use and the old
  directory is no longer the rollback path.

## Acceptance criteria for "migration done"

- [ ] Upgrade completed with no `pg_upgrade` failure lines.
- [ ] Pre/post row counts match for every Arena table that had rows.
- [ ] Application migrations apply cleanly on the new cluster.
- [ ] Arena reads and writes representative records against the new cluster.
- [ ] Rollback (move old directory back) has been exercised once on the copy.
- [ ] Only then does PostgreSQL 18 become the default bundled runtime
      (re-pin `@embedded-postgres/*` in `package.json`, re-run the
      embedded-postgres test suite against 18, and re-verify
      `readDataDirVersion` guard behaviour with `PG_VERSION=18`).

## Current status

- [x] Plan written (this document).
- [x] Backup tool with verification (`scripts/pg-backup.mjs`).
- [ ] Execution against a copy of the real data directory — **not yet run**;
      requires the affected install's data and the 18.x binaries on that
      machine. Nothing in the application depends on this step.
