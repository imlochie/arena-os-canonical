# Recovery & Hardening Report — PostgreSQL 16 recovery, diagnostics, API security

Date: 2026-10-16 · Branch: `arena/7e7916ff-arena-os-canonical` (from `7be5883`)
Scope: the P1–P5 recovery mandate (restore service without losing data, fix
PostgreSQL diagnostics, plan the 16→18 migration, close the critical API
security holes, add regression coverage).

Every claim below is labelled **verified** (executed here, results recorded)
or **unverified** (not executable in this environment, with the reason).

## 1. Initial repository state (verified)

- Working tree clean at `7be5883` ("Waveyard A7 (review R4)"); only `main`
  exists on the remote from this checkout's perspective.
- Baseline test run (`npm test`, Node 22.22.3): **1223 tests — 1153 pass,
  60 fail, 10 skip**. Failure clusters: tests needing a reachable test
  PostgreSQL, `desktop/runtime/migrate.test.ts` (embedded PG binaries could
  not load `libpq.so.5`), toolbox/media tests (ffprobe not executable),
  email (IMAP fixture).
- Baseline verified defect: the bundled `@embedded-postgres/linux-x64` was
  `18.4.0-beta.17` — `postgres --version` reported **PostgreSQL 18.4**
  against data directories created by PostgreSQL 16 (`PG_VERSION = 16`).

## 2. Findings and decisions

| # | Finding | Evidence | Severity | Decision |
| --- | --- | --- | --- | --- |
| F1 | Bundled PostgreSQL 18.4 cannot open existing PG 16 data directories; the app's startup gives no useful error and the incident risk is data loss via "recovery by reinit" | package-lock `18.4.0-beta.17`; `postgres --version` | P0 | Pin all platforms to `@embedded-postgres/*@16.14.0-beta.17` (verified available for linux/windows/darwin × x64/arm64); recovery first, 18 later |
| F2 | `embedded-postgres.ts` collects server output in `bootLog` but startup failures threw `"no output"`; no `PG_VERSION` vs binary-version check existed | `desktop/runtime/embedded-postgres.ts` (exit handler only recorded errors in `running` state) | P1 | Pre-start version guard + `bootLog` preserved into `status.lastError` + initdb only on a truly empty directory |
| F3 | `scripts/environment-restore.mjs` installed `@embedded-postgres/linux-x64` **unpinned** (would silently pull 18.x) | line 87, before change | P1 | Pin to `16.14.0-beta.17` |
| F4 | `/api/arcade` mutations had no owner and no authorisation: any caller could insert game HTML and delete any game by id; the forge persisted code that failed its own validation | `src/app/api/arcade/*` (before change) | P1 | Per-record `owner_id`, owner-scoped delete (403 on foreign rows), validation gate before persistence, route tests against a real DB |
| F5 | `/api/artifacts` mutations unguarded (same class) | `src/app/api/artifacts/*` | P1 | Same ownership model (`desktop-migrations/0016`) |
| F6 | SSRF: `/api/turboagent/health` fetched any caller-supplied URL; source-intake fetched the resolver's `audioUrl` unvalidated (DNS-rebinding gap); yt-dlp ingest fetched caller URLs unvalidated | routes before change | P1 | Shared `src/lib/security/outbound-url.ts` policy (address classification incl. IPv4-mapped/NAT64/6to4, DNS-answer checks, redirect revalidation) applied to all three; model-hub's loopback gate rebuilt on the same classifier |
| F7 | Multipart uploads buffered unbounded (chunked bodies without Content-Length bypassed `upload.size` checks) | `request.formData()` semantics | P2 | `guardedFormData` caps declared and streamed bodies; wired into uploads, toolbox, library/tracks, device-artifacts |
| F8 | Model-hub registry `load()` replace-merge erased every non-hub dynamic model registration whenever the DB was reachable (silent fallback to the wrong engine — surfaced by a routing test) | `src/lib/modelHub/registry.ts`; failing `aiHub.test.ts` case | P2 | Replace-merge scoped to hub-owned ids only |
| F9 | `npm install` install-script policy documented in `.npmrc` but absent from `package.json`; `onnxruntime-node`'s nuget postinstall breaks offline installs (its binary ships in-tarball — verified with `ldd`) | install logs; `.npmrc` | P2 | `engines` + audited `allowScripts` added (approvals for local-only scripts, explicit denials for `onnxruntime-node`, `msedge-tts`, `msgpackr-extract`) |

## 3. Changes implemented

**Recovery (P1)**
- `package.json` / `package-lock.json`: `@embedded-postgres/linux-x64` pinned
  to `16.14.0-beta.17`; `optionalDependencies` declare the same pin for
  windows-x64/darwin-x64/darwin-arm64/linux-arm64 (so a Windows `npm install`
  gets the matching runtime instead of nothing).
- `scripts/environment-restore.mjs`: same pin.
- Verified: `postgres --version` now reports `postgres (PostgreSQL) 16.14`.

**Diagnostics & data safety (P2)** — `desktop/runtime/embedded-postgres.ts`
- `readDataDirVersion` / `parsePostgresMajorVersion` / `describeVersionMismatch`.
- Version guard runs before any start; mismatch error names both versions,
  the directory, and the two recovery options, and states that Arena will
  never delete/overwrite/reinitialise the data directory.
- Damaged/missing `PG_VERSION` with a non-empty directory is refused
  (never "fixed" by initialising).
- Startup failures preserve the server's own output (`— server output: …`)
  in both the thrown error and `status.lastError`; spawn-level errors are
  recorded instead of timing out.

**Migration plan (P3)** — `docs/POSTGRES-16-TO-18-MIGRATION.md`
- `pg_upgrade` runbook against a **copy** (binaries from the same
  distribution, no extensions in the schema — verified in
  `desktop-migrations/`), pre/post row-count verification, application
  migration step, rollback, acceptance criteria. Not executed here (needs
  the real data directory).

**Backup tooling (P1/P3)** — `scripts/pg-backup.mjs`
- Timestamped recursive copy, refuses live clusters (postmaster.pid probe),
  verifies file count + byte total + `PG_VERSION` digest, writes
  `backup-manifest.json`, re-verification support.

**API security (P4)**
- `src/db/schema.ts` + `desktop-migrations/0016_arcade_artifact_ownership.sql`
  (+ `drizzle/0023_…`): `owner_id` on `arcade_games` and `artifacts`,
  backfilled to `LOCAL_OWNER_ID`.
- `src/lib/arcadeStore.ts`: ownership-scoped create/update/delete
  (`not_found` / `forbidden` outcomes).
- Arcade + artifacts routes: `requireUser`, owner recording, 403 on
  cross-owner mutations, 404 on unknown ids, validation gate (unvalidated
  game code is never persisted).
- `src/lib/security/outbound-url.ts` (+ tests): destination classification
  (loopback/private/link-local/CGNAT/multicast/reserved/public incl. decimal
  URL-normalised forms, IPv4-mapped IPv6, NAT64, 6to4), DNS-answer policy
  (every address must pass), redirect revalidation, bounded redirects,
  timeouts. Applied to `turboagent/health` (loopback-only, no DNS),
  source-intake (`safeFetch` on the audio URL, source URL pre-checked),
  `library/ingest` (yt-dlp destination pre-check), model-hub
  (`assertLoopbackUrl` rebuilt on the shared classifier).
- `src/lib/security/request-limits.ts` (+ tests): declared and chunked
  body caps on four multipart routes.

**Testing/infra (P5)**
- `src/lib/modelHub/registry.ts`: replace-merge scoped to hub-owned ids.

## 4. Regression coverage (all executed)

New tests (30): `desktop/runtime/embedded-postgres.test.ts` (10 — incl. a
real-binary test that tampers `PG_VERSION`, proves refusal + untouched data +
recovery), `desktop/pg-backup.test.ts` (4), `src/lib/security/outbound-url.test.ts`
(7 — metadata endpoints, alternate spellings, DNS multi-record, redirect
hops), `src/lib/security/request-limits.test.ts` (4),
`src/app/api/turboagent/health/route.test.ts` (3 — refused destinations
provably never contacted), `src/app/api/arcade/route.test.ts` (2 — real DB
route-level: validation gate, owner scoping, foreign-delete refused).

Full suite after the changes, in a valid test environment (throwaway
PostgreSQL 16 on 127.0.0.1:5432 + `app_db` + `drizzle-kit push`, ffprobe
executable): **1253 tests — 1253 pass, 0 fail, 0 skip** (was 1153/60/10 at
baseline; +30 tests, baseline failures all resolved: embedded-PG symlink
hydration, migration 0016 statement splitting, ffprobe permissions,
test-DB availability, hub-registry replace-merge).

`npx tsc --noEmit` clean. `npm run lint`: 0 errors (45 pre-existing warnings,
none introduced).

## 5. Explicitly NOT done / remaining work

- **Recovery of the real `%LOCALAPPDATA%\Arena` data directory** — unverified
  here (no access to that machine). Next action: run the
  `docs/POSTGRES-RECOVERY.md` runbook there (backup first), then confirm
  records are visible.
- **16→18 migration execution** — planned only (needs the data copy + 18.x
  binaries on the owner's machine).
- **Packaged Windows installer** (`desktop:dist`, `windows:acceptance`) — not
  run in this Linux sandbox; the optionalDependencies pin is unverified on
  Windows until one build is done there.
- **Route-level authentication standardisation** (WebAuthn sessions on every
  route): not attempted. Arcade/artifacts now enforce ownership at the
  operation boundary and inherit the app-wide cross-origin mutation gate;
  `requireUser` remains the single-owner shim (honest for a local-first
  single-owner app; a multi-user deployment must adopt
  `authenticatedRequestIdentity` app-wide — existing workstream).
- **yt-dlp redirect revalidation**: the initial destination is checked;
  redirects inside the child process are a documented residual risk.
- **DNS pinning** (TOCTOU between lookup and connect): residual, documented
  in `outbound-url.ts`; full fix needs a custom undici agent.
- Waveyard performance (separation off the main thread), UX/IA work, and the
  remaining 235-route auth sweep: out of this mandate's scope, unchanged.

## 6. Test-environment note

The suite is green when a test PostgreSQL is reachable and the platform
packages are hydrated. Two install steps were needed in this sandbox and are
now encoded (`allowScripts` + docs): `@embedded-postgres/*` symlink hydration
(runs via postinstall normally) and `chmod u+x` for
`@ffmpeg-installer`/`@ffprobe-installer` binaries (their postinstalls).
`onnxruntime-node`'s nuget postinstall cannot run in restricted networks —
its Linux binding ships in the tarball (verified), so the script is denied
on purpose in `allowScripts`.
