# Waveyard

**Waveyard** is a self-hostable creative music laboratory for taking a source track apart with real source separation, inspecting its stems, and building outward into remix, export, sharing, and collaboration.

It has an original digital-studio/music-archive identity and is not affiliated with or a clone of any commercial stem platform.

## Current phase

**Phase 2 Studio Core is verified in the canonical Compose gate, and Phase 3 adds a worker-owned persisted WAV export path in source.** The real path includes worker-derived private waveform artifacts, authenticated waveform delivery, a shared stem audition transport, persistent non-destructive remix sessions, and export provenance from a persisted RemixVersion. The platform deliberately does **not** claim publication, discovery, collaboration, moderation, beat detection, advanced mastering, or a full DAW. Phase 3 runtime evidence is recorded only after its Compose scenario passes.

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
- [Phase 3 Studio Export](docs/PHASE_3_EXPORT.md)
- [CI and release gate](docs/CI.md)
- [Phase 1 Compose proof report](docs/PHASE_1_REPORT.md)
- [Phase 2 Studio Core design](docs/PHASE_2_DESIGN.md)
- [Phase 2 Studio Core report](docs/PHASE_2_REPORT.md)
- [Publication and moderation](docs/MODERATION.md)

## Verification status

| Check | Status | Meaning |
| --- | --- | --- |
| Phase 0 reconnaissance | verified | The predecessor app was unrelated and removed from the runtime path. |
| TypeScript, unit tests, lint | verified | `typecheck`, seven deterministic unit tests, and lint exit successfully. |
| Production build | verified | Web and worker builds exit successfully. |
| Phase 2 Compose release gate | verified | `npm run test:compose` passed the four-test real-stack Playwright suite against the canonical Compose topology. |
| Real Demucs / CPU | verified in Compose | The release gate performed actual CPU Demucs separation, validated persisted stems and waveform/media access, and completed the lifecycle assertions. |
| Waveform recovery and idempotency | verified in Compose | The gate injected waveform storage-boundary failures and an active-worker restart, then verified retry, cleanup, and duplicate-artifact protection. |
| Authorization and terminal failure handling | verified in Compose | The same suite exercised project/private-media isolation, collaborator roles, corrupt-audio rejection, and terminal Demucs failure without stem creation. |
| Phase 3 worker-owned export | implemented; Compose verification pending | The persisted RemixVersion → export job → FFmpeg worker → private asset path has an added real-stack scenario but is not reported as runtime-passed until the expanded Compose gate completes. |
| CI / release automation | configured | GitHub Actions performs clean static validation and the same Compose release gate; a successful workflow is required as CI evidence. |
| CUDA Demucs | not verified | Requires an NVIDIA/CUDA runtime; never inferred or faked. |
| Production operations | not verified | Cloud storage behavior, backups, monitoring, long-duration load, and production credentials/networking are outside the local Compose gate. |

Read the [CI and release gate](docs/CI.md), [Phase 2 report](docs/PHASE_2_REPORT.md), and [Phase 0 report](docs/PHASE_0_REPORT.md) for the verified scope and remaining boundaries.
