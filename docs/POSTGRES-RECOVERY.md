# Embedded PostgreSQL: PG16 pin, recovery and migration plan

## What happened
`@embedded-postgres/windows-x64` was never declared in `package.json`, so a reinstall floated to
18.4.0-beta.17. Existing user data directories are PG16 (`PG_VERSION=16`), and PG18 refuses them.
The old error surfaced as "exited during startup: no output" because the boot log was never
propagated.

## Changes
- Windows and Linux embedded runtimes are pinned to exactly `16.14.0-beta.17` (Windows as an
  `optionalDependency`). PG18 is **not** the default.
- `desktop/runtime/embedded-postgres.ts`
  - Startup failures now include real postgres output and the exit code.
  - Before start, `PG_VERSION` is compared with `postgres --version`. A mismatch, an invalid
    `PG_VERSION`, or an unreadable bundled version fails with an actionable message and does not
    touch the data.
  - A non-empty data dir without `PG_VERSION` is never auto-initialised.
- Tests: `desktop/runtime/embedded-postgres.test.ts`.

## Recovery of an installed app (manual)
1. Quit Arena. Confirm no `postmaster.pid` in the data dir.
2. Copy the whole data dir to a timestamped backup and compare file counts/sizes.
3. Replace `resources\app\embedded-postgres` with the PG16.14 `native` folder (keep the old one as
   `embedded-postgres.pg18-bak` for rollback).
4. Start Arena; migrations run forward on the existing database.

Rollback: quit Arena, restore the `.pg18-bak` folder name, and restore the data dir from backup if
needed (a newer-major cluster cannot be reopened by an older major).

## Planned PG16 -> 18 migration (NOT executed, NOT default)
Embedded packages ship only `postgres`, `initdb` and `pg_ctl`. `pg_upgrade` is available from a
full PG18 install (e.g. `C:\Program Files\PostgreSQL\18\bin`). Run on a **separate copy**:
1. Copy the backup to a scratch dir; `initdb` an empty PG18 cluster with matching encoding/locale.
2. `pg_upgrade --check`, then the real run with `-b <PG16 bin> -B <PG18 bin>` on the copies.
3. Start PG18 on the upgraded copy; verify table counts, sampled rows, Arena migrations
   (`arena_schema_migrations`), and a representative read/write through the app.
4. Prove rollback: discard the copy and reopen the untouched backup with PG16.
5. Only after all pass, bump the pin to PG18 and add an in-app upgrade step that works on a copy.

Needs roughly 2x the data directory size in free disk (about 150 MB for the current data).

## Security hardening in this change
- `src/lib/security/api-access.ts`: arcade, forge, turboagent-health and ingest routes require a
  loopback request in desktop/dev mode, an internal API key, or an owner session. Per-record
  ownership is **not** modelled: the schema is single-owner.
- `src/proxy.ts`: in desktop mode requests whose Host is not loopback get 403 (DNS rebinding/LAN).
- `src/lib/security/safe-fetch.ts`: scheme/credential checks, all DNS results validated, manual
  redirects revalidated per hop. Applied to turboagent-health, source-intake and ingest
  (yt-dlp follows its own redirects, so redirect targets there remain a residual risk). A
  DNS-rebinding race between check and connect is not closed.
- Arcade: body-size cap, UUID/type validation, and a game-code validator that rejects network,
  navigation and embedding primitives (games also render in a sandboxed iframe).
- Uploads and ingest: Content-Length pre-check before buffering, yt-dlp disk-size watcher,
  socket timeout, and `--` before the URL. Chunked uploads without Content-Length are still
  buffered before the post-parse size check.

## Capability resolver and packaged-install verification (status)
**DONE (committed 01b1596)**
- `src/lib/capabilities/resolver.ts`: env override > bundled `app/bin` (`ARENA_APP_BIN_DIR`) > system PATH; absolute paths, labelled source, system = DEGRADED. Used by ffmpeg/ffprobe, python (deep stems), yt-dlp; taskkill/PowerShell use System32 absolute paths.
- `GET /api/capabilities` (database, migrations, broker, ffmpeg, ffprobe, python, demucs, yt-dlp, local-ai-runtime, network-providers) with path/version/remediation. Unit tests pass.
- Optional: Ollama, LM Studio, WanGP, cloud keys. Developer-only: Docker, Git.
- `desktop:dist` produced the installer (616 MB) and `win-unpacked` with PG 16.14, `bin/ffmpeg.exe`, `ffprobe.exe`, server and migrations; `windows:acceptance --audit-only` passed.

**PARTIAL**
- `desktop:dist` exits 1 at electron-builder's update-info step ("Cannot detect repository"; add `repository` to package.json or `--publish never`). The installer is written first.
- Electron-as-node server launch and absence of PATH `node` are verified by source reading only.

**NOT DONE / UNVERIFIED**
- Full `windows:acceptance` (installs over the real Arena; needs user go-ahead and backup of the PG16.14-swapped install).
- Live `/api/capabilities`, migrations on the new build, crash/restart and stale `postmaster.pid` cleanup on the packaged app.
- Full `npm test` baseline (~9 `mediaArchive/local.test.ts` failures: missing `media_library_items` in the test DB).
- Not bundled yet by design: Python, Demucs, yt-dlp, llama.cpp.
- Drizzle duplicate prefixes 0011-0014, package.json `engines`/`allowScripts`, and the PG16->18 `pg_upgrade` trial remain.
