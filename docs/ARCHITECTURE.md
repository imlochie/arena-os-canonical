# Waveyard Architecture

Waveyard is a self-hosted creative music laboratory built around real source separation. The web app coordinates work; it never performs long-running ML inference in a request handler.

## Runtime topology

```text
browser
  │ HTTPS + signed/private media URLs
  ▼
Next.js web application
  ├── PostgreSQL: users, projects, assets, remix state, jobs
  ├── Redis/BullMQ: durable job dispatch and progress events
  └── StorageProvider: local filesystem or S3-compatible storage
           │
           ▼
Node worker
  └── Python separation process (PyTorch + real Demucs + FFmpeg)
           │
           └── validated stem assets + waveform/export jobs
```

## Boundaries

| Boundary | Responsibility | Must not do |
| --- | --- | --- |
| `apps/web` | UI, auth/session endpoints, authorized resource API, upload orchestration | Demucs/FFmpeg rendering or direct storage credentials in browser code |
| `apps/worker` | BullMQ consumers, job state transitions, isolated temp dirs, subprocess orchestration | user-facing HTTP/session decisions |
| `packages/database` | Drizzle schema, migrations, transaction/repository helpers | UI state or audio decoding |
| `packages/auth` | password hashing, signed sessions, request identity | project-specific permission rules without a caller context |
| `packages/storage` | Local and S3-compatible object operations | database authorization |
| `packages/queue` | job contracts, enqueue helpers, BullMQ connection | business-specific audio processing |
| `packages/audio` | probe/validate audio, waveform/render/separation contracts | browser components |
| `services/separation` | executable real Demucs adapter, device handling, output validation | HTTP, auth, or database access |

## Core entities

```text
User ──< Session
User ──< ProjectMembership >── Project
Project ──< SourceAsset
Project ──< StemAsset
Project ──< ProcessingJob
Project ──< WaveformJob ──< WaveformAsset
Project ──< RemixSession ──< RemixTrack ──< RemixClip
                              └──< RemixVersion ──< ExportJob ── ExportAsset
Project ──< Comment / Activity / Publication
```

A `SourceAsset` stores original file metadata, checksum and private storage key. A `StemAsset` stores its separation job, source type, engine/model/version, actual probed metadata, checksum and private storage key. A `WaveformAsset` belongs to exactly one source or stem asset and records a private, validated peak-document key; its JSON payload is never stored in PostgreSQL or exposed in project-list responses. A `RemixClip` references an existing project stem with timeline/source offsets and gain; it never copies the audio source. An `ExportJob` is immutable provenance over one persisted `RemixVersion`; its one `ExportAsset`, if successful, stores validated output metadata and a private object key without exposing that key to clients.

## Separation engine contract

```ts
interface SeparationEngine {
  prepare(input: PreparedInput, options: SeparationOptions): Promise<void>;
  separate(input: PreparedInput, outputDir: string, options: SeparationOptions): Promise<SeparationResult>;
  validate(result: SeparationResult): Promise<ValidatedStem[]>;
  getMetadata(): Promise<SeparationEngineMetadata>;
  cleanup(): Promise<void>;
}
```

The default adapter invokes `python -m demucs` using `htdemucs` and yields only the sources emitted by that real model: `vocals`, `drums`, `bass`, and `other`. It never fabricates additional instruments. `AUTO` selects CUDA only when PyTorch reports it available; explicit `CUDA` fails when unavailable; `CPU` uses CPU inference.

## Processing lifecycle

```text
QUEUED → PREPARING → PROCESSING → FINALIZING → COMPLETE
                               └────────────→ FAILED
any nonterminal state ─────────────────────→ CANCELLED
```

A processing job has an idempotency key scoped to project/source/model. Worker retries update the same job and atomically replace only the outputs for that job. Assets are persisted only after output existence, decodability, non-zero signal, duration, channels, sample rate, and checksum have been validated.

## Storage and privacy

`StorageProvider` supports `local`, `s3`, and MinIO through the S3 protocol. Private keys use random UUID-derived paths; APIs authorize project membership before issuing a download URL or streaming a local object. Storage credentials stay server-side.

Visibility is a project policy (`private`, `unlisted`, `public`), not a client UI preference. Private source/stem/export assets require a server-side membership check. Public assets are exposed only once publication and license rules permit them.

## Remix principles

A remix is nondestructive state: tracks, clips, transport settings, and version snapshots. The editor shares one authoritative timeline clock and sends only debounced session state changes to the API. Export rendering is a worker job that reads the authoritative arrangement and emits a new real audio asset; it is never faked or rendered in-browser for production export.
