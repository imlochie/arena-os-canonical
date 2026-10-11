# Waveyard Evolution — Implementation Plan

Status: **plan, grounded in the verified architecture below** (inspected 2026-10, baseline `c1a5626`, `npm test` 457/457 green).

Product thesis: Waveyard becomes a **local-first music platform whose native
playback format is the stemmed song** — open → browse → press play → touch the
stems — with Sessions above playback and the existing Studio as the deep
layer. The engine room is built; this plan builds the cockpit around it
**without replacing or regressing anything that exists**.

---

## 1. Verified existing architecture (what we build on)

### 1.1 Product surface today
| Route | Component | Role |
|---|---|---|
| `/waveyard` | `BuildProject` | Home = "Build the first good version" → production project creation (the DAW-first framing this evolution replaces at the top level) |
| `/waveyard/create` | `BuildProject` | Studio-oriented intake (upload / authorized links) |
| `/waveyard/discover`, `/waveyard/p/[id]`, `/waveyard/moderation` | `DiscoverCatalog`, `PublicProject`, `ModeratorReview` | Public catalog (real, keep) |
| `/waveyard/projects/[id]` | `ProjectWorkspace` → `StudioCore` | Build progress, sources, then Studio |

`StudioCore` already has presentation tabs **Play / Studio / Visual** — a
player concept exists, but only *inside* a production project workspace.

### 1.2 Audio engine (client, real, reusable as-is)
`src/lib/waveyard/useStemTransport.ts` — per-stem
`HTMLAudioElement` → `MediaElementAudioSourceNode` → gain → stereo pan →
live insert subgraph (7 real processor types) → explicit mono downmix →
`AnalyserNode` → master gain + master inserts + L/R analysers. Exposes
`register(id, element)`, transport (play/pause/seek/loop), per-stem
`MixerValues` (volume/pan/mute/solo/phaseInvert/monoMonitor),
`isEffectivelyMuted`, and real `MeterSnapshot` (peak/rms/clip from
analysers — **no fake meters**). `MixerConsole` drives it with
`<audio src={/api/assets/${stemId}}>`. **This is the PLAYER's engine.**

### 1.3 Domain model (`src/db/waveyardSchema.ts`, 30 tables)
- `wy_projects` (title, artwork_key, genre, tags, visibility, …)
- `source_assets` (project-scoped audio + codec/duration/checksum metadata)
- `stem_assets` (stemType free text — **not hard-coded to four**; engine/model
  provenance, checksum, storage key). Worker emits exactly
  `vocals | drums | bass | other` (`waveyard-worker/.../separation.ts:31`);
  `passthrough-unseparated` exists as the honest no-worker bridge.
- Analysis family: `source_analyses` (tempo/key/beat grid),
  `source_sections`, `source_events`, `harmony_*`, `drum_*`, `vocal_*`,
  `waveform_assets` (shared source+stem waveform model).
- Arrangement family: `remix_sessions`, `remix_tracks`, `remix_clips`,
  `remix_automation_points`, `remix_versions`, `arrangement_layers`,
  `sound_design_assets`, `cleanup_versions`, `export_jobs/assets`,
  `project_builds`, `automatic_remix_generations`.
- Auth: local-first single owner (`local-context.ts`), no auth subsystem.

### 1.4 Media serving
`GET /api/assets/[id]` serves BOTH source and stem audio from private
storage (signed redirect / stream fallback), with project-role checks.

### 1.5 Runtime & tests
Desktop runtime (supervisor + embedded PostgreSQL + FFmpeg + Next
standalone), Windows packaging, acceptance harness — all proven green on
Windows at `c1a5626`. 63 test files (49 `src/`, 14 `desktop/`),
`desktop-e2e.mjs` runs the full real workflow against the staged package.

---

## 2. Proposed architecture — new layers ABOVE the studio

```
WAVEYARD
├── HOME      /waveyard            library-first: recently played, all music,
│                                  search, playlists, sessions, add-music
├── PLAYER    /waveyard/play/[id]  StemPlayer: big four-stem controls,
│                                  transport, waveform, tempo/key, STEM2 panel
├── SESSION   /waveyard/session    queue + multi-track stem mixing +
│             (and player-integrated)  transitions (built on analyses +
│                                  musical meeting points that already exist)
├── STEM2     adapter layer        capability-state machine, honest states only
└── STUDIO    /waveyard/projects/[id]   EXISTING — untouched, entered by choice
```

### 2.1 Domain additions (additive migrations, both `drizzle/` and `desktop-migrations/`)
| Table | Purpose | Key relations |
|---|---|---|
| `wy_projects.kind` (new nullable column) | `'studio' \| 'library'` — library tracks get an auto-created container project; existing projects default `NULL` = studio | no existing row changes meaning |
| `wy_tracks` | the listening object: title, artist, album, artworkKey, durationSeconds, playCount, lastPlayedAt | UNIQUE `source_asset_id` → `source_assets`; `project_id` → container `wy_projects` |
| `wy_playlists` / `wy_playlist_items` | user playlists (ordered) | items → `wy_tracks` |
| `wy_queue_items` | play queue (ordered, per owner) | → `wy_tracks` |
| `wy_playback_state` | durable transport state: currentTrackId, positionSeconds, stemLevels JSONB, masterVolume, repeat/shuffle | single row per owner — live transport stays client-side, only durable state persists |
| `wy_listen_sessions` / `wy_listen_session_tracks` | SESSION: ordered tracks + per-track stem mix (JSONB) + transition config | → `wy_tracks`; distinct from production `remix_sessions` |

**Reuse rules (no duplication):** audio storage = existing
`source_assets`/`stem_assets` (a track references; it never copies audio);
stems for a track resolve by `sourceAssetId`; waveforms from
`waveform_assets`; tempo/key/beat-grid from `source_analyses`; artwork via
existing `artwork_key` storage pattern. A track is creatable without user
jargon because the container project is an implementation detail
(`kind='library'`), and "Open in Studio" is simply the existing project
workspace — **Studio handoff is free and never duplicates material**.

### 2.2 Player (P2)
New `StemPlayer` component + `/waveyard/play/[trackId]` page:
- drives `useStemTransport` exactly like `MixerConsole` does today
  (`<audio src={/api/assets/${stemId}}>` + `register`), so every control is
  the real audio graph.
- Four prominent stem controls (VOCALS/DRUMS/BASS/MELODY→`other`) with
  volume, mute, isolate/solo, and REAL analyser activity; **renders however
  many stems actually exist** (no four-stem hard-coding — the default view
  just makes four simple).
- Stem availability honesty: separated / full-source-only (passthrough) /
  processing / unavailable (worker offline) — reusing the existing
  capability-reporting vocabulary.
- Waveform: existing `WaveformCanvas` + `waveform_assets`.
- Tempo/key/beat grid shown only when `source_analyses` is `complete`.
- Durable state → `wy_playback_state` (throttled), live state in-memory.

### 2.3 Session (P3)
- Queue + N-track playback: a `useSessionPlayback` hook composed ABOVE
  `useStemTransport` (one transport context per active track, crossfade via
  master gains, per-track stem mix from `wy_listen_session_tracks`).
- Beat/key matching displayed from existing analyses; transitions v1 =
  manual crossfade; v2 = suggestions from the EXISTING
  `/api/remixes/[id]/meeting-points` logic (musical meeting points already
  computed and tested) — approximate matches always labeled as such.
- "Send to Studio" → existing automatic-remix/arrangement generation on the
  container projects (already exists) — explicit derived versions, never
  destructive.

### 2.4 STEM2 (P4)
- `src/lib/stem2/` adapter architecture: `Stem2Adapter` interface +
  capability-state machine with EXACTLY the states
  `AVAILABLE | CONNECTED | AUDIO_ONLY | CONTROL_UNAVAILABLE | UNSUPPORTED |
  REQUIRES_DEVICE_CONNECTION | ERROR`.
- v1 real capability: system audio output (OS-exposed Bluetooth/USB audio)
  = honest `AUDIO_ONLY` (audio routes through the OS; no per-stem control).
  Deeper control only via verified interfaces, isolated behind the adapter
  so nothing unverified touches the player. No fake "connected" states —
  contract tests use explicit fakes, never pretend hardware.

---

## 3. What remains untouched (explicit)

- All existing Waveyard routes, components, and pages (`StudioCore`,
  `ProjectWorkspace`, `BuildProject`, `DiscoverCatalog`, publication,
  moderation, handoff panels) — the Studio surface keeps working unchanged.
- The entire engine: separation worker, analysis family, mixer DSP/inserts,
  arrangement/remix domain, cleanup, sound design, mastering, AI packets/
  proposals, versions, exports, provenance, storage.
- `useStemTransport` internals (consumed, not modified, unless a phase
  proves a concrete defect).
- Desktop runtime, supervisor, embedded PostgreSQL wiring, FFmpeg paths,
  electron-builder packaging, acceptance harness, migrations 0000–current.
- The existing test suite — only additions, never removals/weakenings.

## 4. Phased delivery (each phase: tests + `npm test` + `typecheck` +
`desktop:compile` + `desktop:e2e` green before commit)

| Phase | Deliverable | New tests (minimum) |
|---|---|---|
| **P1 Foundation** | `kind` column, `wy_tracks`/playlists/queue/playback-state schema (both migration sets), tracks CRUD + library intake wrapper (auto container project reusing source-intake/build pipeline), HOME rework (library-first; BuildProject moves under "Studio" entry, not deleted) | track creation from intake, listing/search, play-count, playlist add/reorder, queue ops, container-project invisibility in studio lists |
| **P2 Player** | `/waveyard/play/[id]` + `StemPlayer` (real transport, meters, waveform, analyses, honest availability, responsive), playback-state persistence | player state persistence, stem availability states incl. unseparated, mute/solo/volume wiring (logic level), loop |
| **P3 Session** | queue playback, dual/multi-track session page, per-track stem mixes, crossfade, tempo/key honesty, session save/restore | multiple-track sessions, stem-level persistence, crossfade logic, beat-sync logic (from real analyses), send-to-studio derived version |
| **P4 STEM2** | adapter + states + system-audio integration + player panel | adapter contract, every capability state + transition, error paths, no-device honesty |
| **P5 Polish** | transitions via meeting points, stem swap between tracks, search/browse refinement, responsive pass | transition suggestion correctness, swap provenance |

## 5. Regression safety

- Additive-only schema (nullable columns + new tables); no renames, no
  relocations, no parallel implementations.
- Every phase runs the FULL suite + desktop:e2e before commit; Windows
  acceptance re-run after P2 and P5 (the user-facing milestones).
- Honest capability reporting everywhere (no fake stem availability, no
  fake Stem2 states, no fabricated catalogue — local/authorized music only,
  provider-ready interfaces for the future).
