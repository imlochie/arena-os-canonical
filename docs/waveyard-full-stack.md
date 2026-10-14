# Waveyard full stack — real stems, analysis, exports

The Arena app runs Waveyard's studio at `/waveyard` with zero configuration.
Without a worker it is honest about what is missing: separation, structural
analysis, and audio export are reported as unavailable (jobs are stored with
`queue_unavailable` + the reason), while project management, upload, playback,
waveforms (browser-computed), arrangement editing, versions, and Arena
handoffs all work.

To make **everything** real — the features you'd otherwise pay a separation
service for — run the full stack once with Docker:

```bash
docker compose up --build
```

Then open <http://localhost:3000/waveyard>, drop a track, and press BUILD.

## What runs

| Service | What it is |
|---|---|
| `postgres` | PostgreSQL 16 (all Arena + Waveyard data) |
| `redis` | BullMQ transport between the app and the worker |
| `setup` | One-shot schema push (`npm run db:setup`), then exits |
| `web` | The Arena OS app (all rooms, including `/waveyard`) |
| `worker` | The real Waveyard worker: Demucs separation, ffmpeg waveforms, tempo/key/section/drum/harmony/vocal analysis, WAV/MIDI export |

The web app and worker share one volume (`wy_storage` →
`/app/.data/waveyard-storage`), which replaces the original stack's MinIO/S3
setup — same files, no object-storage credentials.

## Honest expectations

- **Build time:** the worker image installs PyTorch (CPU) + Demucs + ffmpeg.
  The first `--build` downloads a few hundred MB and takes a while.
- **First separation:** Demucs downloads the model weights (~80 MB for
  `htdemucs`) on first use. That's a one-time cost per model.
- **CPU speed:** separating a 3-minute track on CPU typically takes minutes,
  not seconds. For GPU speed, point the worker at a CUDA runtime
  (`STEM_DEVICE` supports `cuda`; you'd need a CUDA-built image — the default
  image is CPU-only, same choice the original project made for portability).
- **Model choice:** `SEPARATION_MODEL=htdemucs` by default. The Demucs family
  the worker supports (e.g. `htdemucs_ft` for highest quality, slower) can be
  set in the environment before `docker compose up`.

## Checking the worker is really healthy

```bash
docker compose ps
docker compose exec worker npm run worker:doctor
```

The doctor reports the **actual** runtime capability: ffmpeg, python, model
availability, Redis, storage, and database reachability. The worker container
healthcheck runs the same doctor — an unhealthy worker is visible in
`docker compose ps`, never silently degraded.

## Where your data lives

- Postgres data → `postgres_data` volume
- Audio/stems/waveforms/exports → `wy_storage` volume
- Redis job state → `redis_data` volume

`docker compose down` keeps them; `docker compose down -v` deletes them.

## Running the worker against your dev instance (no Docker for the web app)

If you run `npm run dev` on your machine but want the real worker:

1. Start Postgres + Redis however you like (the compose ones work:
   `docker compose up -d postgres redis setup`).
2. Point `.env` at them: `DATABASE_URL=...`, `REDIS_URL=redis://127.0.0.1:6379`,
   and set both `WAVEYARD_STORAGE_DIR` and `LOCAL_STORAGE_PATH` to the same
   absolute directory.
3. `cd waveyard-worker && npm install && npm run worker`
   (requires Node 22, ffmpeg, Python 3 + pip with `demucs` installed).

The worker directory is the original Waveyard worker preserved verbatim — see
`waveyard-worker/README.md`.

## The deep pass without any of this (A7)

The app itself can run the deeper six-source separation (htdemucs_6s →
vocals, drums, bass, guitar, piano, other — the residual, shown as "Other")
whenever the machine has the deep engine prepared. Two steps, both the
owner's, nothing downloaded by the app:

1. `python3 -m pip install demucs`, or point `WAVEYARD_DEEP_PYTHON` (or
   `PYTHON_BIN`) at an interpreter that has it;
2. place the model checkpoint `5c90dfd2-34c22ccb.th` in `WAVEYARD_MODELS_DIR`
   (default `.data/waveyard-models`, the same directory as the MDX models).
   It is Demucs' own `htdemucs_6s` weight file: download it from
   `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th`,
   or copy it out of the torch hub cache (`~/.cache/torch/hub/checkpoints/`
   on Linux/macOS, `%USERPROFILE%\.cache\torch\hub\checkpoints\` on
   Windows) if Demucs has ever been run on that machine. The bridge loads it
   with `--repo <WAVEYARD_MODELS_DIR> --name 5c90dfd2`, so Demucs verifies the
   checksum and never reaches for its remote store.

The pass rides the app's own local job pipeline — no Redis, no worker
container — and reports the exact missing step (including the exact
checkpoint path it looked for) on the surfaces that offer it (the upload's
"Deep — 6 stems" target, the stem deck's ⇊ per-lane action, the models route
and the desktop diagnostics). One active deep job per target: a repeat
request while one is running is a 409; after it completes or fails the
target can be run again. Deployments that run the Python worker keep
choosing the worker's model with `SEPARATION_MODEL` instead. Decisions:
`docs/ADR-007-deep-separation-engine-bridge.md`.
