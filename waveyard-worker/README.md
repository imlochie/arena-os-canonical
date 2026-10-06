# Waveyard worker (preserved, runnable)

This directory preserves the **real Waveyard worker subsystem** from the
original Waveyard project (branch `arena/01a0bebf-arena-os-canonical`), ported
verbatim. The Arena OS Waveyard room (`/waveyard`) is the same studio, and this
worker is what makes stems, analysis, waveforms, and exports real when it runs.

## What it does

- `apps/worker/src` — BullMQ worker consuming the same nine queues the Arena
  app enqueues on (`waveyard-separation`, `waveyard-waveform`,
  `waveyard-source-analysis`, `waveyard-source-section-analysis`,
  `waveyard-source-event-analysis`, `waveyard-drum-analysis`,
  `waveyard-harmony-analysis`, `waveyard-vocal-analysis`, `waveyard-export`):
  separation (Demucs), waveform generation (ffmpeg), tempo/key/section/event
  analysis, drum/harmony/vocal analysis, MIDI export, audio render, and
  automation. `doctor.ts` reports honest runtime capability (ffmpeg, python,
  model presence, redis, storage, database).
- `services/separate.py`, `services/analysis/*.py` — the python services the
  worker drives.
- `packages/{types,queue,storage,database,audio}` — the original workspace
  packages (the Arena app carries its own ports under `src/lib/waveyard/`).
- `tests/unit` — the original vitest suite for the worker modules (the pure
  domain tests also run inside Arena's own suite under
  `src/lib/waveyard/types/__tests__/`).

## Running it

**Easiest (recommended):** the repo root ships a `docker-compose.yml` that
builds and runs this worker together with the app, Postgres, and Redis:

```bash
docker compose up --build   # from the repo root
```

See `docs/waveyard-full-stack.md` for expectations and health checks.

**Manually (where Redis + ffmpeg + Python already exist):**

```bash
cd waveyard-worker
npm install                # workspace install (self-contained package.json + lockfile)
npm run worker             # apps/worker
npm run worker:doctor      # capability report — honest, no guesswork
```

Point the Arena app at the same Redis and database:

```
REDIS_URL=redis://...      # the app enqueues; the worker executes
```

Without `REDIS_URL` (or without bullmq installed), the Arena app reports every
worker-gated feature as **unavailable** — jobs are stored with
`queue_unavailable`, nothing is faked. The browser-computed waveform path
(`stage: browser-computed`) and the explicitly labeled
`passthrough-unseparated` stem are the only offline bridges, and both say
exactly what they are.
