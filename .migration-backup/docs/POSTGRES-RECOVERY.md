# PostgreSQL Recovery Runbook

**Status:** recovery implemented and verified in this repository (see
[Verification](#verification-in-this-repository)). Applying it to a real
affected install (a data directory with `PG_VERSION = 16` opened by a build
that bundled PostgreSQL 18) follows the steps below.

## What went wrong

An Arena build began bundling PostgreSQL **18.4**
(`@embedded-postgres/*@18.4.0-beta.17`) while existing installs had data
directories created by PostgreSQL **16**. PostgreSQL refuses to open a data
directory from a different major version, so the embedded server failed at
startup. Two aggravating defects hid the real problem:

1. The startup failure path collected the server's output in a local
   `bootLog` but threw `"no output"` — the actual FATAL line
   (`database files are incompatible with server`) never reached
   `status.lastError` or the user.
2. Nothing compared the data directory's `PG_VERSION` with the bundled
   server's major version before starting, so the failure surfaced only as
   a terse crash after a 30-second readiness timeout.

**Rule of this recovery: the existing data directory is never deleted,
overwritten, reinitialised, or migrated in place to make the app boot.**

## What changed in the repository

| Change | Where |
| --- | --- |
| Embedded PostgreSQL pinned to **16.14** (`@embedded-postgres/*@16.14.0-beta.17`) on every platform | `package.json`, `package-lock.json` |
| Windows/macOS/arm64 platform packages declared (so `desktop:dist` on Windows installs the matching runtime) | `package.json` `optionalDependencies` |
| Environment bootstrap installs the pinned version instead of `latest` | `scripts/environment-restore.mjs` |
| Pre-start version guard: `PG_VERSION` vs `postgres --version`; actionable error on mismatch; refuses damaged/missing version metadata | `desktop/runtime/embedded-postgres.ts` (`readDataDirVersion`, `describeVersionMismatch`) |
| Startup failures preserve the server's own output in `status.lastError` | `desktop/runtime/embedded-postgres.ts` |
| initdb runs **only** on a truly empty data directory — never as a fallback | `desktop/runtime/embedded-postgres.ts` |
| Verified backup tool | `scripts/pg-backup.mjs` |
| Regression tests (fake-spawn + real-binary) | `desktop/runtime/embedded-postgres.test.ts` |

## Recovering an affected install (e.g. Windows,
`%LOCALAPPDATA%\Arena\data\postgres`)

1. **Quit Arena.** Confirm no `postgres.exe`/`postgres` process holds the
   data directory.
2. **Back it up** (must succeed before anything else):

   ```bash
   node scripts/pg-backup.mjs "C:\Users\<you>\AppData\Local\Arena\data\postgres" --out "C:\Users\<you>\AppData\Local\Arena\backups"
   ```

   The tool refuses to copy a live cluster, verifies the copy
   (file count, byte total, `PG_VERSION` digest) and writes
   `backup-manifest.json` into the timestamped destination. Keep this
   backup: it is the rollback anchor for the 16→18 migration.
3. **Check the marker yourself** — `PG_VERSION` in the data directory must
   read `16`.
4. **Install an Arena build that bundles PostgreSQL 16** (this branch pins
   `@embedded-postgres/*@16.14.0-beta.17`). On the build machine, run
   `npm install` (the `hydrate-symlinks` postinstall must run — it only
   creates local symlinks) and build/package as usual.
5. **Start Arena.** With a matching runtime, the same data directory opens
   as-is. Previously persisted records (projects, waveyard library,
   sessions, arcade, …) must be visible — that visibility is the acceptance
   criterion, not a green splash screen.
6. If startup still fails, the error now contains the server's own output
   (`status.lastError`, `logs/`). Preserve it; it is diagnosis, not noise.

## What the application now guarantees

- A data directory with `PG_VERSION = 16` and a bundled 18.x server fails
  **before** touching the cluster, with an error that names both versions,
  the directory, and the two recovery options (matching runtime, or
  `pg_upgrade` on a copy per `POSTGRES-16-TO-18-MIGRATION.md`).
- A data directory with files but no readable `PG_VERSION` is refused —
  Arena will not "clean it up".
- A first run (no data directory) is the only path that runs `initdb`.
- No fallback ever initialises a new cluster over an existing one.

## Patch-version packaging (PostgreSQL 16.15)

PostgreSQL 16.15 (upstream, 2026-08-13) fixes issues present in 16.14.
The `@embedded-postgres/*` packages have **not yet published a 16.15
build** (verified 2026-10-16: newest 16.x on npm is `16.14.0-beta.17` for
every platform). Until they do:

- 16.14.0-beta.17 remains the recovery pin — the newest packaged 16.x,
  and same-major with any 16.x data directory.
- When `@embedded-postgres/*@16.15.x` lands: bump the pins in
  `package.json` (`devDependencies` + `optionalDependencies` +
  `allowScripts` keys), run `npm ci`, re-run
  `desktop/runtime/embedded-postgres.test.ts` and `migrate.test.ts`, and
  smoke-start against a **backup copy** of the data directory. This is a
  minor bump within major 16 — no dump/restore and no `pg_upgrade`; the
  data directory opens as-is. Do not migrate the real database for a
  patch release.
- Do not build bespoke PostgreSQL binaries for Arena: the packaging
  risk outweighs the patch delta while 16.14 is healthy.

## Verification in this repository

Executed in the development environment (Linux x64, Node 22):

- `postgres --version` on the pinned package reports
  `postgres (PostgreSQL) 16.14` (before the pin it reported 18.4).
- `desktop/runtime/embedded-postgres.test.ts` — 10/10 pass, including the
  real-binary test that starts a real cluster, tampers `PG_VERSION` to
  `18`, proves startup is refused with the actionable error **and the data
  directory is byte-identical afterwards**, then restores the marker and
  proves the same data opens again.
- `desktop/runtime/migrate.test.ts` — 2/2 pass against real embedded
  PostgreSQL 16 (fresh apply, tracking, skip-on-restart, rollback).
- `desktop/pg-backup.test.ts` — 4/4 pass (live-cluster refusal, verified
  copy, manifest, tamper detection).

Not verified here (requires the affected Windows install): recovery of a
real `%LOCALAPPDATA%\Arena` data directory, and the packaged Windows
installer (`windows:acceptance`). Run those on the machine that holds the
data, with the backup from step 2 in place.
