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
cp .env.example .env       # edit if your local Postgres differs
npx drizzle-kit push       # creates the 18 tables (first run)
npm run dev                # http://localhost:3000
```

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

- **Available** (existing app surfaces): Assistant, Orchestrator (Command),
  Council, Spaces (Projects), Archive Assistant (Artifacts), Classroom
  (Guide), Studio (Collab), LUMA (Image), Device Security (Privacy).
- **No service connected**: Congress, Cut Lab, **Waveyard** — these have no
  routes on this branch. `GET /waveyard` here is a 404 by design, not a bug.

### Archive Assistant (bridge to the archive app)

The Archive Assistant room is a live, read-only bridge to the
[Archive Assistant](https://github.com/imlochie/SomeSafePortablesoftware) app
(Arena's sibling repository): overview, workload, reconciliation summary,
finding lineage, and Plex/Jellyfin provider state. The bridge is mounted on
this baseline; whether it is *connected* depends on server configuration —
the room page shows the real state. Architecture and guarantees:
[`docs/archive-assistant-integration.md`](docs/archive-assistant-integration.md).

```bash
# .env — for a locally running Archive Assistant (AUTH_MODE=local):
ARCHIVE_ASSISTANT_API_URL=http://127.0.0.1:8080/api
ARCHIVE_ASSISTANT_AUTH_MODE=local
ARCHIVE_ASSISTANT_OWNER_ID=__local__
```

Read-only by construction: Arena can never approve, reject, reopen, execute,
rename, move, download, or sync anything in Archive Assistant. Full bounded
context: `GET /api/archive/context` (with `?history=1` for one page of
provider refresh history). Run the bridge test suite with `npm test`.

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
