# Arena OS

Personal AI hub: models, assistants, workforce roles, projects with memory,
artifacts, privacy controls, and a rooms directory with explicit handoffs.

This branch is the **ratified canonical baseline** — the verified historical
hub plus the rooms map and draft handoff ledger. Which branch is what, and
why, is recorded in [`docs/arena-branch-convergence-audit.md`](docs/arena-branch-convergence-audit.md).

## Quick start

Requirements: Node 22+, PostgreSQL 16+.

```bash
npm install
npm run dev               # .env is auto-created from .env.example on first run
npm run db:setup          # creates app_db (if missing) + applies the schema
```

`npm run build` also self-provisions `.env` — a fresh clone builds without
manual steps. The database only needs to be reachable for the API routes;
pages render regardless. If your local PostgreSQL credentials differ from
the default (`postgres:postgres@127.0.0.1:5432`), edit `.env` — the drizzle
config reads the same `DATABASE_URL`, so there is exactly one place to change.

Production build:

```bash
npm run build && npm start
```

Notes:

- `npm run build` only needs `DATABASE_URL` to **exist** — the database
  connection is opened lazily. The API routes need a reachable PostgreSQL.
- `drizzle.config.json` carries its own connection URL
  (`postgresql://postgres:postgres@127.0.0.1:5432/app_db`) used by
  `drizzle-kit push`. If your local Postgres credentials differ, update
  **both** `.env` and `drizzle.config.json`.
- Example for creating the database, if needed:

  ```bash
  psql -U postgres -c "CREATE DATABASE app_db;"
  ```

## Rooms

`/rooms` is the honest map of what is connected. Each room states its own
status; believe it.

- **Available**: Assistant, Orchestrator (`/orchestrator` — multi-participant
  collaboration bus), Council, **Congress** (`/congress` — timed multi-seat
  deliberation with durable records), **Spaces** (`/spaces` — recurring agent
  workbench), **Classroom** (`/classroom` — executable teaching loop over the
  Lochie Life College curriculum), **Archive Assistant** (live read-only bridge
  to the Archive Assistant app — see below), Device Security (Privacy).
- **No service connected**: Studio, Cut Lab (media engines on unmounted
  branches), **Waveyard** (lives on `arena/01a0bebf-arena-os-canonical` —
  `GET /waveyard` here is a 404 by design, not a bug), LUMA (standalone app on
  `arena/01a0bdc9-arena-os-canonical`).

**No AI configuration is required.** Every AI surface (chat, battles, council,
congress, classroom, orchestrator, spaces) runs on the offline local engine by
default — deterministic, zero egress, zero keys. Optional quality upgrades when
you want them: provider keys in the UI, the browser on-device engine (Arcade),
or a local TurboAgent server.

### Archive Assistant (bridge to the archive app)

The Archive Assistant is MERGED into Arena OS — native, no external app,
no bridge. The `/rooms/archive-assistant` room is the control panel: connect
Plex or Jellyfin (token sealed AES-256-GCM in the local database), run real
syncs, reconcile the local archive index against your libraries, and work the
review queue (decisions recorded; nothing renamed/moved/deleted/downloaded).
The six read operations the old bridge served — overview, workload,
reconciliation summary, finding lineage, provider refresh state + history —
are served from Arena's own tables and still validated against the generated
contract: `GET /api/archive/context` (with `?history=1`). The old external
integration doc is kept for history:
[`docs/archive-assistant-integration.md`](docs/archive-assistant-integration.md);
the merge design lives in
[`docs/archive-assistant-merge.md`](docs/archive-assistant-merge.md).

### Waveyard (music room)

Waveyard — source intake, real Demucs stem separation, analysis, remixing,
export, publication — lives on the `arena/01a0bebf-arena-os-canonical`
branch, mounted alongside a namespaced copy of this hub. To run it locally:

```bash
git fetch origin
git worktree add ../arena-waveyard arena/01a0bebf-arena-os-canonical
cd ../arena-waveyard
docker compose up --build   # needs Docker; brings up Postgres, Redis, MinIO,
                            # migrations, web (:3000) and the worker
```

See that branch's README for the manual stack (Postgres, Redis, ffmpeg,
Python + Demucs) if you would rather not use Docker.

## Models

Chat and battles run in local mode without any keys. Provider keys are
optional, user-supplied, and entered in the UI.

## Verification history

- Clean-install build, all pages, health, read/write APIs, and local-mode
  chat verified 2026-10-06 — see audit §8 (R1).
