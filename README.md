# Waveyard

**Waveyard** is a self-hostable creative music laboratory for taking a source track apart with real source separation, inspecting its stems, and building outward into remix, export, sharing, and collaboration.

It has an original digital-studio/music-archive identity and is not affiliated with or a clone of any commercial stem platform.

## Current phase

**Phase 2 Studio Core is implemented in source.** The real path now includes worker-derived private waveform artifacts, authenticated waveform delivery, a shared stem audition transport, and persistent non-destructive remix sessions. The platform deliberately does **not** claim worker-side remix rendering/export, publication, discovery, collaboration, moderation, beat detection, or a full DAW.

The implemented path is real code, not seeded output:

```text
register → private project → server-validated audio upload → BullMQ jobs
→ dedicated worker → python -m demucs / FFmpeg waveform extraction
→ validated private stems + peak documents → authenticated Studio audition/remix metadata
```

The path requires PostgreSQL, Redis, storage, FFmpeg, PyTorch, and Demucs. If those services are absent or a model fails, jobs report failure; the app never invents stems or completion.

## Quick start (Docker)

```bash
cp .env.example .env
# Change SESSION_SECRET before exposing anything outside local development.
docker compose up --build
```

Open <http://localhost:3000>. Docker Compose starts PostgreSQL, Redis, MinIO, migrations, web, and the CPU Demucs worker. The first separation downloads the configured Demucs model, so it can take materially longer than later jobs.

## Development

```bash
npm ci
cp .env.example .env.local
# Start PostgreSQL, Redis and MinIO or provide equivalent service URLs.
npm run db:migrate
npm run dev
npm run worker
```

Run the real separation acceptance command only where FFmpeg, Python, PyTorch, and Demucs are installed:

```bash
STEM_DEVICE=cpu npm run prove:demucs
```

The command generates an original deterministic fixture, invokes actual Demucs, and checks for valid, non-silent `vocals.wav`, `drums.wav`, `bass.wav`, and `other.wav`. It fails rather than using mocks if its dependencies are unavailable.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Reconnaissance and scope](docs/RECONNAISSANCE.md)
- [Audio pipeline](docs/AUDIO_PIPELINE.md)
- [Storage](docs/STORAGE.md)
- [Workers](docs/WORKERS.md)
- [Remix engine](docs/REMIX_ENGINE.md)
- [Phase 1 Compose proof report](docs/PHASE_1_REPORT.md)
- [Phase 2 Studio Core design](docs/PHASE_2_DESIGN.md)
- [Phase 2 Studio Core report](docs/PHASE_2_REPORT.md)
- [Publication and moderation](docs/MODERATION.md)

## Verification status

| Check | Status in this workspace | Meaning |
| --- | --- | --- |
| Phase 0 reconnaissance | verified | The predecessor app was unrelated and removed from the runtime path. |
| TypeScript, unit tests, lint | verified | `typecheck`, seven deterministic unit tests, and lint exit successfully. |
| Production build | verified | Web and worker builds exit successfully. |
| Phase 2 Compose E2E discovery | verified | The real-stack browser suite includes waveform, download, remix snapshot/restore, and authorization assertions; it is listed but not executed here. |
| Real Demucs / CPU | failed honestly | The proof reached the real Python adapter, which stopped because PyTorch/Demucs are absent in this host. |
| CUDA Demucs | not verified | Requires an NVIDIA/CUDA runtime; never inferred or faked. |
| Compose upload through Studio | not verified | Docker and dependent services are unavailable in this sandbox. |

Read the [Phase 2 report](docs/PHASE_2_REPORT.md) and [Phase 0 report](docs/PHASE_0_REPORT.md) before treating any unchecked capability as complete.
