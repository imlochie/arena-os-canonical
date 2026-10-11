# Arena OS — Windows Desktop Architecture

Status: **Phase 1 implemented; this plan is the contract for the phases that follow.**
Companion to `docs/arena-branch-convergence-audit.md` (implementation log).

> **Waveyard web product frozen at `3b4ea88`** (Block 2 complete — see
> `docs/waveyard-completion-plan.md` Part 8: 400/400 tests, 35-step live
> E2E, restart persistence verified). The desktop phase now owns the
> remaining runtime dependencies: bundled FFmpeg/FFprobe, the supervised
> local worker (Redis replacement or embedded), embedded Postgres, and
> optional AI providers. One product caveat travels forward from the
> freeze: **bus routing is not a persisted subsystem** (STEM + MASTER
> only) — see Part 8 before touching the routing story.

The goal is not "it launches." The goal is: *I installed Arena on a Windows PC
and it behaves like Arena is actually a Windows application.* The browser
application remains first-class and unchanged; the desktop is an additive
runtime around the same core.

---

## Part 1 — Audit of what actually exists (2026-10-07, @ f56b245)

### 1. Server startup path
- Next.js 16.3.8. `next dev` / `next build` / `next start`, each preceded by
  `scripts/ensure-env.mjs` (creates `.env` from `.env.example` if absent —
  never overwrites).
- A real readiness contract already exists: `GET /api/health` →
  `select 1` against Postgres → `{ ok: true }` (`src/app/api/health/route.ts`).
  The desktop startup handshake builds on this — no sleeps.

### 2. Database runtime
- PostgreSQL via `pg` + `drizzle-orm`. `DATABASE_URL` env. Migrations:
  `drizzle/0000…0010_*.sql`, applied by `scripts/db-setup.mjs` (idempotent).
- No SQLite. No ORM magic beyond drizzle. **Decision (Phase 6): embedded
  PostgreSQL** (`embedded-postgres` npm family ships win-x64 binaries; already
  proven in this repo's Linux live-testing) under
  `%LOCALAPPDATA%\Arena\data\postgres`. SQLite is explicitly rejected —
  schema/transactions/JSON behavior stay identical to the web app.

### 3. Waveyard worker requirements (inspected, not assumed)
- `waveyard-worker/` is a preserved separate workspace: a Node **BullMQ worker**
  consuming the same nine queues the app enqueues on, plus **Python services**
  (`services/separate.py` = Demucs separation, `services/analysis/*.py`),
  plus **ffmpeg**, **Redis**, **Postgres**, and the shared storage dir.
  `apps/worker/src/doctor.ts` reports honest capability (ffmpeg, python,
  model presence, redis, storage, database).
- Queue in the app: `src/lib/waveyard/queue.ts` (bullmq + ioredis).
  **Without `REDIS_URL` the app runs fine and every worker-gated feature
  reports honestly unavailable** — this degradation must survive the port.
- Desktop plan (Phase 5): the supervisor runs app server + embedded Postgres +
  local Redis-compatible queue + the worker as supervised children. Redis on
  Windows decision (bundled native build vs. alternative) is made in Phase 5
  after a live test — documented, not guessed. Python/Demucs is the heavyweight
  dependency; the capability model reports its absence honestly rather than
  faking separation.

### 4. FFmpeg/FFprobe assumptions
- Spawned bare from `PATH` (`spawn("ffprobe")`, `spawn("ffmpeg")` in
  `src/lib/waveyard/audio.ts`). No bundling, no env override, no version
  reporting. Phase 4 adds: bundled-first resolution → system fallback →
  honest `unavailable` with the resolved path and version surfaced through
  the desktop capability model.

### 5. Local storage locations
- `.data/waveyard-storage` (`WAVEYARD_STORAGE_DIR`; worker-side name
  `LOCAL_STORAGE_PATH`), `.data/space-workspaces` (Spaces).
- **LUMA projects live in browser localStorage** (downscaled inlined source
  image) — verified at `src/components/LumaStudio.tsx:149`
  ("Projects (this browser)"). Desktop must give LUMA a real filesystem path
  (see Part 3).

### 6. Current process boundaries
- One Node process (Next server: UI + API), external Postgres, external
  optional Redis, optional separate worker process (Node + Python children),
  browser (UI, WebLLM local engine, camera, localStorage).
- Desktop target: Electron main owns all of the above as supervised children
  (except the browser, which the Electron window replaces).

### 7. Environment-variable dependencies
- `DATABASE_URL` (required), `REDIS_URL` (optional), `SEPARATION_MODEL`,
  `STEM_DEVICE`, `WAVEYARD_STORAGE_DIR`, `MAX_UPLOAD_BYTES`,
  `MAX_WAVEFORM_PCM_BYTES`, `ARCHIVE_ASSISTANT_API_URL` (optional,
  explicitly never a localhost fallback).
- The desktop runtime becomes the single authoritative source of these values,
  derived from the Windows data directory — the repo never learns a Windows
  path by guessing.

### 8. Browser-vs-server boundaries
- Server-only: DB, storage fs, ffmpeg, queue, mission tooling
  (`src/lib/spaces/tools.ts` — spawn with win32 shell fix).
- Browser-only: localStorage projects (LUMA), WebLLM in-browser engine
  (`@mlc-ai/web-llm` — model cache location becomes a desktop concern),
  camera capture. The desktop window reuses all of this unchanged.

### 9. Security-sensitive IPC candidates
- Spaces `run_command` (mission allowlist child_process — **stays inside the
  server process, never exposed over Electron IPC**).
- Desktop IPC surface (pickers, reveal-in-Explorer, external URLs,
  notifications, diagnostics) is allowlisted, typed, and zod-validated.
  The renderer never receives `child_process`, `shell`, or filesystem access.

### 10. Smallest viable Electron integration path
- Electron main resolves the Windows data dir → sets env (`DATABASE_URL`,
  `WAVEYARD_STORAGE_DIR`, …) → starts embedded Postgres → starts the Next
  server on a bound 127.0.0.1 port → **health-polls `/api/health`** → opens
  the window against that origin only. Everything else is additive phases.

### LUMA — verified state (independent audit, confirmed in code)
The engine is ahead of the room: `ArenaMediaBridge` exists but the default is
`noopArenaMediaBridge` (throws "Arena integration is not configured"),
`EditRecipe` carries `crop` + `analysis`, the store has
`addLayer/updateLayer/removeLayer/reorderLayer`, the `advanced` block is
reserved-but-unimplemented, and projects persist to localStorage. The desktop
arc finishes this integration (Part 3, workstream L).

---

## Part 2 — Target architecture

```
Arena.exe (Electron)
  └─ main process (desktop/)          ← owns Windows concerns only
      ├─ data-directory service       %LOCALAPPDATA%\Arena (or portable)
      ├─ JSONL logger + ring buffer   logs\arena-desktop.log
      ├─ child-process supervisor     spawn/capture/readiness/restart/kill-tree
      ├─ embedded PostgreSQL          data\postgres
      ├─ Redis-compatible queue       (Phase 5 decision, live-tested)
      ├─ Waveyard worker              optional, honestly reported
      ├─ Next.js server (Arena core)  127.0.0.1:<fixed>, env from data dir
      └─ BrowserWindow                contextIsolation, sandbox, no node
          └─ renderer = existing Arena web UI + typed preload bridge
```

### Data directory (Phase 3 — landed as `desktop/paths.ts` in Phase 1)
```
%LOCALAPPDATA%\Arena\
  data\  projects\  waveyard\  cache\  logs\  models\  runtime\  settings\
```
Resolution order: `ARENA_DATA_DIR` env (absolute, validated) → portable
marker (`arena.portable` beside the exe → data beside the app, opt-in only) →
platform default. Pure, unit-tested with **win32 semantics on any host**
(the waveyard containment bug is the canonical reason).

### Capability model (Phase 4/16)
`/api/runtime/desktop` + IPC surface reporting exactly: platform, arch, app
version, data dir, ffmpeg/ffprobe (resolved path + version or honest
absence), worker, queue, database, local AI runtime, GPU/WebGPU. The existing
`/api/runtime/status` remains the provider/model health surface. The UI binds
to this model: "Separation unavailable" stays "Separation unavailable."

### Security model (Phase 18)
- contextIsolation ✓, nodeIntegration off ✓, sandbox ✓ (Phase 1, in code)
- IPC: channel allowlist + zod validation, typed contracts in
  `desktop/contracts.ts` — one file is the whole surface
- navigation locked to the app origin (+`file://` splash during startup);
  window.open denied; permissions denied by default; external links via
  main-side `shell.openExternal` only
- Spaces mission tooling is server-side application logic — never bridged
  into Electron IPC; the two capability systems stay separate by design

### Offline model (Phase 15)
LOCAL: UI, storage, DB, Waveyard processing, models, Arcade, Spaces
execution, project management. REMOTE OPTIONAL: Groq/OpenRouter/Pollinations/
Archive Assistant. Local never masquerades as cloud.

---

## Part 3 — Phase roadmap (each phase: implement → test → runtime-verify → document)

| Phase | Deliverable | Key change |
|---|---|---|
| 1 ✅ | Desktop shell | `desktop/` Electron main + preload + typed IPC + data-dir service + logger + child registry + splash; icon; win32-semantics tests |
| 2 | Embed the app | main starts Next server (prod build) with data-dir env; real `/api/health` handshake; diagnostic screen with subsystem/path/exit-code/recovery/logs |
| 3 | Windows data model | runtime env derives all paths; waveyard storage + space workspaces under data dir (containment tests extended) |
| 4 | Media toolchain | bundled-first ffmpeg/ffprobe resolution, versions, honest absence; `/api/runtime/desktop` capability surface |
| 5 | Worker supervisor | supervisor starts/tests queue + worker (Python/Demucs optional); crash detection, backoff restart, no loops, logs, status to UI |
| 6 | Embedded Postgres | `embedded-postgres` win-x64 under data dir; init/migrate on first run; schema parity proven by existing suite against it |
| 7 | Native file ops | IPC: open/save/choose-dir/reveal/open-external — zod-validated, no arbitrary shell |
| 8 | Drag & drop | Explorer drops flow through the same upload pipeline (shared ingestion, no second path) |
| 9 | Tray/background | close-to-tray while jobs run; explicit behavior; jobs never lost |
| 10 | Notifications | Windows toast on real job state transitions only |
| 11 | Update architecture | version reporting, channel abstraction, metadata, safe lifecycle, rollback awareness (signed releases later) |
| 12 | Packaging | electron-builder NSIS: `Arena-Setup-x64.exe`, icon, publisher, start menu, uninstall, clean upgrade |
| 13 | Portable build | marker-file portable mode; never write into Program Files |
| 14 | OS integration | native title bar semantics, Ctrl+O/Ctrl+Shift+S, reveal, dialogs, clipboard, window-state + session persistence |
| 15 | Offline guarantee | local/remote split enforced + tested |
| 16 | Capability UI | UI decisions driven by the capability model end-to-end |
| 17 | Diagnostics center | logs, worker logs, health, versions, jobs, crash reports, copy-diagnostics, "Open Logs Folder" |
| 18 | Security hardening | audit of every addition against the Phase 18 checklist |
| 19 | Windows tests | win32-semantics unit tests everywhere paths/processes touch; real Windows smoke script |
| 20 | Desktop E2E | launch → rooms → project → upload MP3 → persisted source + job → honest capability → relaunch → state intact |
| 21 | Browser parity | shared core + adapters; desktop-only features additive |
| 22 | Clean-machine doc | validation on Win10/11 with no Node/npm/Git/Docker/Redis/ffmpeg |
| L | LUMA completion | (L1) filesystem projects via desktop adapter, localStorage adapter for browser; (L2) wire `ArenaMediaBridge` to a real Arena media service; (L3) layers/crop/adaptive surfaces in the room; (L4) preset workflow |

Workstream L rides *after* the runtime phases it depends on (L1 needs Phase 3,
L2 needs Phase 4/7) — the desktop transition is the moment LUMA stops being
an island, per the integration audit.

## Part 4 — Honest unknowns (decided by live test, not assumption)

- Redis-compatible queue on Windows (Phase 5): bundled native build vs.
  alternative; the queue is optional-by-design so this can't fake-healthy.
- Python/Demucs distribution size for the installer (Phase 5/12); if omitted,
  separation reports unavailable — never fake.
- Embedded Postgres runtime prerequisites on clean Windows (VC++ redist) —
  resolved in Phase 22's clean-machine test.
- WebGPU/GPU detection surface on Windows (Phase 4) — report what's real.

## Part 5 — Development modes

- **User mode:** `Arena.exe` — no Node, npm, Git, Docker, Python, ffmpeg, or
  Redis required on the machine.
- **Developer mode:** `npm run desktop` (compiles `desktop/` then launches
  Electron against the repo). Note: installing the `electron` devDependency
  downloads its binary via postinstall — on machines that block install
  scripts, allow it once or set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (web-only
  contribution). All existing npm workflows are untouched.
