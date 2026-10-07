# Arena Desktop Runtime Plan — Phase 2 (audited before implementation)

Companion to `docs/windows-desktop-architecture.md` (Phase 1 shell) and
`docs/waveyard-completion-plan.md` (frozen web product @ `3b4ea88`).

This document records the **audited** process graph and the runtime
decisions made from it. Nothing below was assumed; every claim was read
out of the repository.

---

## 1. Audited process graph (web/dev mode today)

```
npm run dev / next start
  └─ Next.js server (single Node process)
       ├─ src/db (pg + drizzle) ──────► PostgreSQL (external, DATABASE_URL)
       ├─ src/lib/waveyard/storage ───► .data/waveyard-storage (CWD-relative
       │                                  unless WAVEYARD_STORAGE_DIR set)
       ├─ src/lib/waveyard/audio ─────► ffprobe/ffmpeg (server probe with an
       │                                  honest client-probe fallback)
       ├─ src/lib/waveyard/queue ─────► BullMQ/ioredis (lazy; without
       │                                  REDIS_URL every enqueue throws and
       │                                  routes mark job rows failed
       │                                  `queue-unavailable` — honest 503s)
       └─ local-context auth ─────────► fixed LOCAL_OWNER (no auth subsystem)
```

Key facts established by inspection:

- **Startup**: `prestart` → `scripts/ensure-env.mjs` (creates `.env` from
  `.env.example`, never overwrites) → `next start`. A real readiness
  contract exists: `GET /api/health` → `select 1` → `{ok:true}`.
- **Database**: migrations live in `drizzle/0000…0015_*.sql` but are NOT
  applied as SQL in dev — `npm run db:setup` runs `drizzle-kit push`
  (schema diffing, devDependency). The packaged runtime cannot depend on
  drizzle-kit, so it needs SQL-file migrations (see §4).
- **Worker**: `waveyard-worker/` is a preserved separate workspace
  (BullMQ worker + Python Demucs separation + ffmpeg). Engines by job
  type (read from its source):
  - **export** → pure FFmpeg `filter_complex` render (per-clip
    atrim/asetpts/[atempo]/aformat/[pitch]/pan/volume/fades/adelay →
    amix normalize=0 → master volume → pcm_s16le WAV). V1 boundary:
    automation is rendered via per-frame volume/pan expressions.
  - **waveform** → FFmpeg mono 44.1 kHz s16le decode → bounded peaks at
    resolutions [256,512,1024,2048,4096] → `waveyard-peaks-v1` JSON.
  - **source analysis** → `waveyard-numpy-dsp` (Python) — BPM/key/beat grid.
  - **separation** → Python Demucs.
  - sections/events/drums/harmony/vocal analyses → derived from analysis + stems.
- **Ingest** (`POST /api/uploads`): multipart → server ffprobe (or honest
  client-probe fallback) → source_asset + acquisition + separation job +
  waveform job rows → `enqueueSeparation` + `enqueueWaveform`. Each queue
  failure marks only that job's row failed; the upload itself persists.
- **Retry routes** (`source-analyses|waveform-jobs|exports/[id]/retry`)
  all re-enqueue through `enqueue*` in `src/lib/waveyard/queue.ts` — one
  interception point covers enqueue AND retry.
- **Auth**: `local-context.ts` — a fixed local owner; no sessions. The
  desktop inherits this unchanged.
- **Desktop Phase 1 shell** (`desktop/`): Electron main with single
  instance, data-dir resolution (env > portable marker > platform
  default), logger, child-process registry with Windows tree-kill, frame
  policy (origin equality), zod-validated IPC allowlist, splash + smoke
  harness.

## 2. Desktop process graph (target)

```
Arena.exe (Electron main)
  └─ ArenaRuntimeSupervisor (desktop/runtime/supervisor.ts)
       1. resolve RuntimeConfig (desktop/runtime/config.ts)
       2. EmbeddedPostgres.ensureStarted()      (initdb on first run,
          postgres spawn, readiness via pg connect probe)
       3. applyMigrations()                     (desktop-migrations/*.sql,
          tracked in arena_schema_migrations)
       4. storage + dirs init                   (app-data, not CWD)
       5. spawn server (standalone next server.js in packaged mode;
          `next dev` in desktop dev mode)
          env: DATABASE_URL, WAVEYARD_STORAGE_DIR, ARENA_DESKTOP_MODE=1,
               ARENA_FFMPEG_PATH/ARENA_FFPROBE_PATH, PORT, HOSTNAME
       6. poll GET /api/health (no sleeps on guesswork)
       7. open window → http://127.0.0.1:<port>
       8. supervise children; ordered shutdown on quit
```

Inside the server process, when `ARENA_DESKTOP_MODE=1`:

```
src/instrumentation.ts (register(), once per process)
  └─ startLocalWorker()  (src/lib/waveyard/worker-local/)
       └─ LocalJobBroker: in-process queue (globalThis singleton —
          Turbopack instantiates separate module graphs for
          instrumentation vs routes), serial execution, graceful
          drain on SIGTERM
          handlers (real engines, same DB semantics as the worker):
            waveyard-waveform                → app's generateWaveform (FFmpeg)
            waveyard-source-analysis         → arena-js-dsp (JS DSP engine)
            waveyard-source-section-analysis → arena-js-structure
                                               (bar-aligned novelty boundaries)
            waveyard-export                  → FFmpeg render (ported)
            waveyard-separation              → NO local executor (Python/
             (no handler)                      Demucs not packageable) →
                                              enqueue throws an honest
                                              desktop reason; the existing
                                              route catch marks the row
                                              failed. Isolated, visible in
                                              diagnostics.
```

Web/cloud/dev mode is **untouched**: without `ARENA_DESKTOP_MODE=1`
the queue module behaves exactly as before (BullMQ when REDIS_URL is
set; honest queue-unavailable otherwise).

## 3. FFmpeg strategy (audited, then decided)

- Resolution order (`src/lib/waveyard/ffmpeg.ts`):
  1. `ARENA_FFMPEG_PATH` / `ARENA_FFPROBE_PATH` (packaged mode: supervisor
     passes explicit paths to bundled binaries in the app resources)
  2. `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe` (npm
     platform packages — binaries come from the npm registry, no github
     downloads; win32-x64 + linux-x64 both exist)
  3. PATH (development convenience only)
- `probeAudio`/processing call sites route through the resolver — uploads
  are fully server-probed whenever a binary resolves.
- All invocations are `spawn(path, args[])` — never a shell, never a
  user-controlled string in a command position.
- Diagnostics exec `-version` and report the active binary + version.
- **Bundled binary version reality**: @ffmpeg-installer ships ffmpeg
  4.1-era static builds (2018). `amix` has no `normalize` option there,
  so the desktop export render replaces `amix=…:normalize=0:duration=longest`
  with an explicitly padded + summed graph (`apad=pad_len` per clip,
  then `amerge`+`pan` plain sum in ≤32-input chunks) — verified against
  the actual bundled binary: identical +6.02 dB gain for two identical
  sources (amix 4.1 would attenuate by 1/n), exact timeline duration,
  true silence between non-overlapping clips.
- Licensing: `@ffmpeg-installer` redistributes GPL ffmpeg static builds;
  the Windows installer carries the FFmpeg license notice
  (`desktop/build/licenses/FFMPEG-LICENSE.txt` via extraResources).

## 4. Database strategy

- **Embedded PostgreSQL**, real binaries, no fake:
  `@embedded-postgres/linux-x64` / `windows-x64` (npm registry, no
  github) as **optionalDependencies** — the correct platform installs
  everywhere, others are skipped by npm.
- First run: `initdb` into `<dataDir>/postgres` (random 24-byte hex
  password from a 0600 runtime secret file, `-A scram-sha-256`, UTF8,
  C locale), then `create database arena` via an admin connection, then
  migrations. Bind: `127.0.0.1` + ephemeral persisted port + runtime-owned
  socket dir on POSIX.
- **Migrations**: `desktop-migrations/` — a drizzle-kit-generated
  canonical snapshot (`0000_initial_schema.sql`, 66 tables) plus future
  ordered deltas. Applied by `desktop/runtime/migrate.ts` using `pg`
  only (no drizzle-kit at runtime), tracked in
  `arena_schema_migrations(name, applied_at)`, each file in one
  transaction. Upgrades = new files; the runtime never diffs.
- Clean shutdown: SIGINT (`pg_ctl stop -m fast` equivalent), SIGQUIT
  fallback. Crash: registry kill-tree. A stale `postmaster.pid` is
  detected by probing the recorded PID — never blindly deleted.
- Linux detail: the binary package ships unversioned `.so` names only
  for some libs; the supervisor sets `LD_LIBRARY_PATH` to the package's
  lib dir for the children. Windows: `PATH` prepend of bin/lib dirs.

## 5. Worker strategy — decision: (B) local queue adapter

Redis cannot be bundled for Windows from npm honestly, and the BullMQ
worker needs it. The spec's option **B** — a genuine desktop/local queue
adapter preserving job semantics — is the least invasive production
choice:

- `enqueue()` gains one branch: desktop mode → `LocalJobBroker.submit()`.
  Same payload, same jobId, same DB row lifecycle the routes already
  implement (queued → running → succeeded/failed, attempts, errorCode).
  Queue-API calls (retry routes) route to the broker too (`getJob` →
  undefined → the routes' enqueue fallback path, which submits fresh).
- Handlers are **ports of the worker's engines** where the engine is
  FFmpeg (waveform, export) and **new real engines** where the worker
  used Python (source analysis → `arena-js-dsp`, sections →
  `arena-js-structure`). Provenance is honest: analyses persist
  `arena-js-dsp` / `arena-js-structure`, never the Python engine's name.
- Separation (Demucs) has **no** local executor and fails loudly with a
  desktop-specific reason — isolated in diagnostics, never silently
  skipped. Desktop users get waveform + analysis + sections + arrangement
  + export through the existing "use unseparated source" passthrough
  surface; stems require the Python worker.
- Desktop pipeline trigger port: on desktop the separation worker cannot
  provision the analysis row, so the waveform handler provisions it
  (engine arena-js-dsp) and enqueues analysis once all related waveform
  jobs are terminal — the same `maybeQueueSourceAnalysis` trigger the
  worker runs for stems. MIDI exports fail honestly
  (`midi_requires_worker`): every MIDI kind needs Python analyses.
- Job semantics preserved: serial execution (audio is heavy), in-flight
  jobId dedup (BullMQ jobId semantics), failure marks the row failed
  with the real error, retry routes work unchanged.
- One product fix was required (uploads route): it returned 503 on
  separation-queue failure BEFORE attempting the waveform enqueue — on
  desktop that would have made every upload unprocessable. Each queue is
  now attempted independently and each durable row records its own
  honest failure boundary. Web behavior is unchanged (the 503 still
  happens when separation cannot queue; the response now also carries
  `waveformQueued`).

## 6. What the packaged app contains

electron-builder (NSIS): Electron shell + `desktop/dist` + splash/
diagnostics pages; `extraResources`: the Next standalone server
(`output: "standalone"` + `.next/static` + `public/` staged inside the
server tree), `desktop-migrations/`, FFmpeg/FFprobe binaries,
embedded-postgres windows-x64 binaries, license notices. No dev caches,
no test fixtures, no local databases (created at runtime in the user's
app-data dir), no secrets. `outputFileTracingExcludes` keeps repo trees
(docs/, scripts/, waveyard-worker/, desktop/) out of the traced server.

## 7. Environment constraints found during THIS implementation

This sandbox has no Windows, no display, and github.com binary downloads
are TLS-blocked (npm registry works). Therefore, implemented and verified
here: the full runtime supervisor + embedded Postgres + local worker +
FFmpeg engines + standalone server, driven headless through the **same
supervisor module** the Electron main process calls, plus a complete
Linux "desktop-mode" E2E over the staged installer tree
(`npm run desktop:e2e`). The Electron main wiring is written and
unit-tested headlessly (`npm run desktop:smoke` keeps the Phase 1 shell
test). The Windows NSIS artifact itself cannot be produced or executed in
this environment — electron/electron-builder download github-hosted
binaries (TLS-blocked here). The packaging configuration is complete and
committed (`npm run desktop:dist` on a networked Windows machine);
building it requires a machine with github.com access. This is documented
rather than faked.

`npm run desktop:dist` was ATTEMPTED in this sandbox to establish the
exact boundary: staging + electron-builder config validation + rebuild-skip
all succeed; the run fails only at the Electron runtime zip download
(`⨯ unable to verify the first certificate`, github.com TLS). Two
packaging decisions came out of that attempt and are recorded here:

- **Turbopack standalone emits `pg` as a symlink.** The Next standalone
  output contains `.next/node_modules/pg-<hash>` — a symlink to
  `../../node_modules/pg`. Node's `cpSync` `dereference: true` does NOT
  dereference symlinks nested inside a copied directory (and the default
  rewrites the link to an absolute path into the repo build tree), so a
  naive copy ships a tree that 500s every DB route the moment the repo's
  `.next` is rebuilt — i.e. "works on the build machine, broken for every
  user". `desktop-prepare-server.mjs` therefore materializes every symlink
  under `server/` into a real copy and enforces a self-containment guard
  (staging fails if any staged symlink resolves outside `desktop-package/`).
  `desktop-e2e.mjs` re-asserts the invariant, and the E2E was run green
  with the repo's `.next` directory deleted to prove the staged tree is
  genuinely standalone.
- **`npmRebuild: false`** (electron-builder): the asar contains only the
  compiled desktop shell, which imports zero native modules (node builtins
  + zod + local code). The heavy runtime ships as extraResources and runs
  in a separate `ELECTRON_RUN_AS_NODE` process, not inside Electron, so
  rebuilding native modules against Electron's ABI is unnecessary — and
  impossible to cross-compile from Linux anyway. The native modules that
  do run server-side (sharp, msgpackr-extract) use N-API prebuilds, which
  are ABI-stable across Node and Electron.

## 8. Verification map (headless proof vs Windows proof)

| Claim | Headless E2E (this repo, Linux) | Windows packaged app |
| --- | --- | --- |
| initdb/migrations/DB lifecycle | ✅ `desktop:e2e` | required |
| standalone server + health | ✅ | required |
| local worker queues (4) | ✅ | required (same code) |
| upload/waveform/analysis/sections/export | ✅ | required |
| persistence + restart | ✅ | required |
| staged tree self-containment (no repo deps) | ✅ (E2E with `.next` deleted) | n/a (guaranteed by staging) |
| FFmpeg bundled-binary discovery | ✅ (staged tree) | required (win32 paths) |
| Electron startup/supervision/window | unit-level only | **required** |
| NSIS installer, %LOCALAPPDATA% data | n/a | **required** |
| Windows process tree shutdown | logic unit-tested | **required** |
