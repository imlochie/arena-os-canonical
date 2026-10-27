# Phase 0 — Repository Reconnaissance

**Date:** 2026-09-20

**Decision:** Hard rebuild for the Waveyard open-source stem platform.

## Evidence

The initial checkout is an unrelated Next.js application named `ArenaForge Personal`. It contains multi-agent AI chat, model battles, Council workflows, a small arcade experiment, and a PostgreSQL schema for that product. It contains no music domain model, audio ingestion pipeline, waveform code, source separation engine, queue, object-storage abstraction, authentication, test suite, Docker stack, or audio fixtures.

Runtime inspection found Python 3.11 but no FFmpeg executable, PyTorch installation, Demucs installation, Docker CLI, Redis server, or existing compose configuration. Therefore no audio processing claim can be verified in this workspace before the new container/toolchain is installed.

## Classification

| Existing area | Classification | Rationale |
| --- | --- | --- |
| Next.js / TypeScript baseline | **REBUILD** | The technologies are suitable, but the structure and dependencies are tied to an unrelated product. |
| PostgreSQL / Drizzle experience | **ADAPT** | Retain the stack choice only; replace the schema and migration history entirely. |
| Dark visual styling | **RETIRE** | It is a command-centre language for AI work, not the original digital-studio/music-archive identity required here. |
| AI provider, Council, battle, chat, game, rating, privacy code | **RETIRE** | Unrelated domain logic. It must not leak into music processing, user access, or product UX. |
| Existing schema/migration | **RETIRE** | Has no user ownership or music/audio relationships; one incomplete migration is not a viable foundation. |
| Existing static docs | **RETIRE** | They describe Arena rather than this platform. New documentation reflects only implemented Waveyard behavior. |

The old source remains recoverable through Git history. It is intentionally not carried into the Waveyard runtime, schema, or UI.

## Canonical first slice

The first working slice is deliberately narrow:

```text
registered user
  → private project
  → validated audio upload
  → durable separation job
  → BullMQ worker
  → real Demucs invocation
  → validated vocals / drums / bass / other assets
  → storage records
  → synchronized real-audio playback
```

No portion of this chain may be simulated. When infrastructure or Demucs is unavailable, the system reports an actionable failed/unavailable state.

## Phase gate

Phase 0 is complete when the repository has a clean music-focused monorepo boundary, container/toolchain plan, canonical domain model, and no legacy code in the runtime path. Audio processing is **not verified** until `prove:demucs` runs Demucs against a copyright-safe fixture and validates actual output audio.
