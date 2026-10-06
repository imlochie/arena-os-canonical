# Arena OS as a Windows desktop app — roadmap

Goal: a single Windows application. No terminal window, no user-managed
servers, no Docker knowledge. Double-click → Arena.

This is a plan, not a finished port. It is ordered so every phase ships
something usable on its own, and nothing in the current codebase blocks it —
the adapter seams added during the Waveyard port (local-owner context, the
storage provider interface, the queue adapter) are exactly what the desktop
build will swap.

## Where we are (Phase 0 — available today)

`docker compose up --build` runs the full stack (app + Postgres + Redis + the
real Waveyard worker) — see `docs/waveyard-full-stack.md`. That is the full
capability, but it still assumes Docker and a terminal. The desktop app is
about removing that assumption.

## Phase 1 — Desktop shell (the visible difference)

**Electron, hosting the Next.js server in the main process.**

- Electron's main process is Node 22 — the same runtime the app already
  targets. The production Next server (`next start` equivalent) runs in the
  main process, bound to `127.0.0.1` on a random free port. A window opens on
  that port. No terminal ever appears; closing the window stops the app.
- Why Electron over Tauri for this app: the app *is* a Node server; hosting it
  in-process (instead of Tauri's sidecar binary) removes process plumbing and
  keeps one runtime. Cost: a larger installer (~100 MB vs ~15 MB). If size
  matters later, the same wrapper contract can be re-implemented in Tauri
  with the Node server as a sidecar.
- Bundled in this phase: embedded PostgreSQL binaries (start/stop managed by
  the app — the same approach that already works in this repo's sandbox
  provisioning) and Redis for Windows… is the one awkward dependency, which
  is why Phase 2 exists. Interim honest option: Phase 1 ships with the
  compose stack managed by the app ("Arena Worker" background service) until
  Phase 2 removes Redis entirely.

## Phase 2 — Remove Redis (queue → database)

BullMQ/Redis is only a transport. The `processing_jobs` / `waveform_jobs` /
analysis-job tables **already model the queue** (status, stage, attempts,
idempotency keys). A small database-backed queue adapter implements the same
surface the web app uses (`enqueueSeparation`, `getWaveformQueue()`, …) over
Postgres with a polling worker loop. The Waveyard worker gets the same
adapter in front of its handlers. Result: one less service, same semantics,
same honest failure states.

## Phase 3 — Single-file data (Postgres → embedded/SQLite)

Two options, in order of preference:

1. **Keep embedded PostgreSQL** (Phase 1 already ships it): zero code change,
   the schema stays as-is. Data lives in `%LOCALAPPDATA%/ArenaOS/data`.
2. **Migrate to SQLite** (drizzle supports it; uuid→text, jsonb→text,
   real/timestamp map cleanly): single-file, smaller, simpler backups — but
   it is a real schema migration and touches every query module. Only do this
   if installer size or copy-a-project-around portability starts to matter.

## Phase 4 — Bundle the media toolchain

- **ffmpeg/ffprobe**: static binaries beside the exe; `PATH`-independent
  resolution in `src/lib/waveyard/audio.ts` (one helper that prefers a
  bundled binary, falls back to system).
- **Demucs/Python**: the heaviest piece (PyTorch CPU ≈ 800 MB installed).
  Two honest options:
  - *Installer bundles it* (huge download, zero-setup), or
  - *First-run provisioning*: the app downloads the Python embeddable
    distribution + `pip install demucs` into app-data with a real progress
    window. Slower start, smaller installer. The doctor report stays the
    source of truth either way.
  - GPU: detect an NVIDIA runtime at start; offer a CUDA-enabled worker
    package when present. Never guess — report.

## Phase 5 — Packaging and updates

- `electron-builder` → NSIS/MSI, desktop shortcut, file associations.
- Auto-update channel (or plain "new version available" check).
- The `waveyard-worker/` sources build into a worker exe (Node SEA or a
  second Electron-utility process) — no separate install.

## What deliberately does not change

- The web app itself: same Next.js codebase in dev, in compose, and in the
  desktop shell. One codebase, three deployment shapes.
- Honesty rules: the worker doctor, the labeled offline bridges
  (`client-webaudio` probe, `browser-computed` waveforms,
  `passthrough-unseparated` stems), and per-feature unavailable states all
  carry over unchanged.
- Local-first data: everything stays on the user's machine by default.

## Rough size of the work

| Phase | Effort | User-visible result |
|---|---|---|
| 1 | Days | Double-click app; no terminal |
| 2 | Days | No Redis dependency |
| 3 | Days (option 2) / trivial (option 1) | Single data location |
| 4 | Days–a week | Real separation without Docker |
| 5 | Days | Installer + updates |

Phase 1 + 2 + 4 together are what "Arena as a Windows app with working
stems" means. Phases 3 and 5 are polish.
