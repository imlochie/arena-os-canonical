# Phase 2 Design — Studio Core

## Goal

Provide the smallest credible private music workspace over Waveyard’s real source/stem assets without moving storage, database, FFmpeg, or render responsibility into the browser.

## Decisions

| Concern | Decision | Operational reason |
| --- | --- | --- |
| Waveform representation | Private checksummed `waveyard-peaks-v1` JSON with five deterministic min/max resolutions | Small UI payloads; no invented waveform samples; inspectable validation boundary |
| Waveform generation | Dedicated BullMQ queue and worker-only FFmpeg decode | Keeps CPU/IO work out of request handlers and permits durable failure state/retry |
| Waveform access | Asset-addressed authenticated API that rechecks project viewer role | Prevents storage-key leakage and cross-project reads |
| Waveform storage | Object storage for payload; PostgreSQL only for relationships/status/metadata | Avoids storing audio or large derived binary/JSON values in the database |
| Browser playback | One shared Web Audio/media-element transport | Real authenticated audition with centralized seeking, gain/pan/mute/solo, but no claim of sample-perfect DAW timing |
| Download delivery | Authorized asset route, local stream or S3 signed redirect; `download=1` requests attachment disposition | Keeps private object access server-side and supports normal playback/range requests |
| Remix model | Session → fixed stem tracks → non-destructive clips; state-only versions | Clips refer to existing assets and never copy or overwrite original audio |
| Remix persistence | Server normalization, project editor role, asset project check, debounced UI saves | Protects against malformed state and cross-project clip injection |
| Undo/redo | 80 in-memory edits; named versions persisted explicitly | Useful local ergonomics without misrepresenting every action as a durable snapshot |

## Data flow

```text
private audio asset
  → durable waveform job
  → worker download to isolated temp directory
  → FFmpeg mono s16 PCM decode
  → deterministic min/max peak document
  → private object storage + waveform asset record
  → authorized bounded read API
  → React waveform visualization

existing private stems
  → editor creates RemixSession/tracks/default clips
  → UI edits metadata and debounces authenticated PUT
  → server normalizes and validates track/asset ownership
  → PostgreSQL persists current state / explicit version snapshots
```

## Non-goals

Phase 2 does not implement source separation in the browser, a database audio blob, S3 credentials in React, render/export jobs, beat analysis, arbitrary instruments, public sharing, collaboration, or a fake fallback waveform/audio result. A stale/failed waveform job remains visibly unavailable instead of being replaced with synthetic data.

## Release gate

Static checks and isolated unit tests establish code quality only. The Compose suite remains the only accepted real-stack verification for PostgreSQL migration behavior, Redis/BullMQ job consumption, MinIO/S3 access, FFmpeg output, Demucs stems, and authenticated browser behavior.
