# Waveyard

**Waveyard** is a self-hostable creative music laboratory for taking a source track apart with real source separation, inspecting its stems, and building outward into remix, export, sharing, and collaboration.

It has an original digital-studio/music-archive identity and is not affiliated with or a clone of any commercial stem platform.

## Current phase

**Phase 2 Studio Core, Phase 3 worker-owned persisted WAV export, and Phase 4 Publication & Discovery are verified in the canonical local Docker Compose gate.** The real path includes worker-derived private waveform artifacts, authenticated waveform delivery, a shared stem audition transport, persistent non-destructive remix sessions, export provenance from a persisted RemixVersion, and an explicit selected-final-render publication boundary. The platform deliberately does **not** claim collaboration, social feeds, recommendations, beat detection, advanced mastering, or a full DAW. Phase 4 passed the expanded seven-test local Compose gate on a Docker-capable host; this is distinct from GitHub Actions CI verification.

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
- [Phase 3 verification report](docs/PHASE_3_REPORT.md)
- [Phase 4 Publication & Discovery](docs/PHASE_4_PUBLICATION.md)
- [Phase 4 verification report](docs/PHASE_4_REPORT.md)
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
| Phase 3 worker-owned export | verified in Compose | On a Docker-capable host, `npm run test:compose` passed all five real-stack tests in 3.3 minutes, including persisted RemixVersion export, intentional terminal failure, same-job manual retry, and successful re-render. |
| Phase 4 Publication & Discovery | verified in Compose | At `a1c8e37c3623a72dc6b9a5aee2bd10eabfe76cb5`, `npm run test:compose` passed all seven real-stack scenarios in 3.1 minutes: explicit publication, safe public final-release delivery/discovery, private-data boundaries, reporting, and moderator hide/restore/remove lifecycle. |
| CI / release automation | configured; GitHub runtime evidence blocked externally | GitHub Actions is configured for clean static validation and the Compose release gate, but no successful Actions run is claimed: runner allocation is blocked by an external billing limitation. |
| CUDA Demucs | not verified | Requires an NVIDIA/CUDA runtime; never inferred or faked. |
| Production operations | not verified | Cloud storage behavior, backups, monitoring, long-duration load, and production credentials/networking are outside the local Compose gate. |

Read the [CI and release gate](docs/CI.md), [Phase 4 report](docs/PHASE_4_REPORT.md), [Phase 3 report](docs/PHASE_3_REPORT.md), [Phase 2 report](docs/PHASE_2_REPORT.md), and [Phase 0 report](docs/PHASE_0_REPORT.md) for the verified scope and remaining boundaries.
