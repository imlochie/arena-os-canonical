# Waveyard

**Waveyard** is a self-hostable creative music laboratory for taking a source track apart with real source separation, inspecting its stems, and building outward into remix, export, sharing, and collaboration.

It has an original digital-studio/music-archive identity and is not affiliated with or a clone of any commercial stem platform.

## Current phase

**Phase 0 and the narrow upload → queue → Demucs → storage → playback foundation are implemented in source.** The platform deliberately does not claim that remixing, export rendering, public publication, discovery, collaboration, moderation, or waveform UI are complete yet.

The implemented path is real code, not seeded output:

```text
register → private project → server-validated audio upload → BullMQ job
→ dedicated worker → python -m demucs → validate outputs → storage → private synchronized playback
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
- [Publication and moderation](docs/MODERATION.md)

## Verification status

| Check | Status in this workspace | Meaning |
| --- | --- | --- |
| Phase 0 reconnaissance | verified | The predecessor app was unrelated and removed from the runtime path. |
| TypeScript, unit tests, lint | verified | `typecheck`, two unit tests, and lint exit successfully. |
| Production build | verified with non-fatal warnings | Web and worker builds exit successfully; see the phase report for sandbox lockfile/trace warnings. |
| Real Demucs / CPU | failed honestly | The proof reached the real Python adapter, which stopped because PyTorch/Demucs are absent in this host. |
| CUDA Demucs | not verified | Requires an NVIDIA/CUDA runtime; never inferred or faked. |
| Compose upload through playback | not verified | Docker and dependent services are unavailable in this sandbox. |

Read [the Phase 0 report](docs/PHASE_0_REPORT.md) before treating any unchecked capability as complete.
