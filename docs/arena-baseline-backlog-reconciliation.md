# Arena OS — Baseline & Backlog Reconciliation

**Date:** 2026-11-06  
**Branch:** `arena/84676e63-arena-os-canonical`  
**Baseline:** `33c876ae6da0adff2dc362e8c0bd339f93495649` (`33c876a`)  
**Current HEAD:** `e906fbf`  
**Working tree:** clean  
**Remote:** `origin` = `https://github.com/imlochie/arena-os-canonical.git`  
**History:** full (627 commits; shallow clone removed)  
**Phase:** 1 + 2 complete. No new product implementation after the owner's Waveyard-first directive.

---

## 0. Mission lock and operating contract

The owner's directive is the primary objective:

> Waveyard becomes the priority. Everything else waits. Build the complete smart remix experience: music understanding, intelligent song matching, real-time stem manipulation, automated mashup creation, remix/arrangement studio, and musical quality.

The owner also established a permanent operating contract:

1. **Mission lock** — preserve the original task; do not silently redefine it.
2. **Bounded investigation** — investigate only what is necessary; record unrelated discoveries separately.
3. **Execution over commentary** — implement, test, fix, verify, commit, push.
4. **Recommendation discipline** — only relevant, necessary, evidence-backed, actionable recommendations.
5. **Context retention** — maintain a task ledger; reread source rather than inventing direction.
6. **Failure handling** — identify the actual failure; fix the smallest relevant area; report genuine blockers.
7. **Completion rule** — demonstrate acceptance criteria; report what changed, tests, what remains unverified, commit SHA, push state.
8. **Owner authority** — the owner's objective takes priority over agent suggestions.

This report follows that contract. It does **not** merge PRs, reset branches, modify Replit, or start new product implementation. The only code changes in this session are the two verified test/CI fixes described in §G, plus a CI diagnostic step that is still failing and is reported honestly.

---

## A. Repository state

| Item | Value |
|---|---|
| Current branch | `arena/84676e63-arena-os-canonical` |
| Current HEAD | `e906fbf` |
| Baseline | `33c876a` |
| Working tree | clean |
| Remote | `origin` (GitHub) |
| Shallow clone | no (full history fetched) |
| Commits | 627 |
| Replit task IDs in commit metadata | 138 |
| Open PRs | 16 |
| Open branches | 30+ (preserved) |

Recent commits:

| SHA | Subject |
|---|---|
| `e906fbf` | ci(windows): retain per-file desktop test evidence |
| `085a58a` | Skip Linux-only admission cleanup tests on Windows |
| `20f9864` | Make Waveyard library integration suite migration-accurate |
| `33c876a` | Keep restored-source analysis and waveform data checksum-accurate |
| `dade20d` | Add storage-fallback cross-tab stem recovery coverage |

### Deployment state

- `.replit` declares `nodejs-24`, `python-base-3.13`, `postgresql-16`, deployment target `autoscale`.
- No live Replit deployment was verified from this sandbox. No server was started.
- `replit.md` states that the Windows/Electron packaging source is retained but no Windows installer has been built or verified in the hosted runtime.
- Local Mode blocks cloud AI but permits registered loopback-only inference.
- No remote database contents were imported.

### CI state (live)

| Workflow | Latest result | Notes |
|---|---|---|
| Windows x64 package | **failure** at `Run desktop packaging unit tests` | Fails in 1m23s–1m40s, before installer packaging. Same failure on `main` and on this branch. |
| Waveyard browser timing | **in progress** (4–10+ min) | Browser installation/matrix; not yet a verified result. |
| Linux Arcade admission | not run here | Workflow is `workflow_dispatch` only. |
| Windows Arcade containment | not run here | `workflow_dispatch` only. |
| Windows native audio isolation | not run here | `workflow_dispatch` only. |

The Windows job now runs each desktop test file separately and uploads per-file evidence, but the artifact download host is blocked from this sandbox. The artifact exists; its contents are not retrievable here. This is an environment limitation, not proof that the tests pass.

### Evidence actually run in this session

| Check | Result |
|---|---|
| `pnpm run typecheck` | pass |
| Waveyard library integration suite (real embedded PostgreSQL 16 + FFmpeg/FFprobe) | **53 pass, 0 fail, 4 skip** |
| Waveyard live-stem + key-shift + session-key-matching + session-logic | **173 pass, 0 fail** |
| Desktop test suite (Linux) | **129 pass, 0 fail, 9 skip** |
| Conversion engine + restore cleanup + broker + startup recovery + Studio accessibility + clip-donor | **13 pass, 3 fail** before env; after providing embedded PG/FFmpeg and `NODE_ENV=test`, the non-browser failures pass; the clip-donor test still requires Chromium |
| Playwright browser scripts | blocked: no Chromium/Firefox/WebKit installed |
| Replit connector | unsupported; no queue export available |

---

## B. Architecture

### B.1 Directory structure

```
artifacts/
  arenaforge/        React 19 + Vite frontend (rooms, Waveyard, Studio, Arcade, Spaces)
  api-server/        Express + TypeScript API, imported route handlers
  mockup-sandbox/    UI mockup sandbox
lib/
  arena/             shared application/engine logic (Waveyard, Studio, Arcade, Spaces, AI, security)
  db/                Drizzle schema + PostgreSQL client
  api-client-react/  generated API client
  api-spec/          OpenAPI spec
  api-zod/           generated Zod contracts
desktop/             Electron + Vite + Express Windows runtime, native host, packaging
scripts/             acceptance scripts, fixtures, smoke tests
docs/                Arcade/Waveyard research, acceptance notes
.agents/memory/      prior agent task notes and evidence
```

### B.2 Runtime components

- **Frontend:** React 19, Vite 7, Tailwind 4, TanStack Query, Zustand, Radix UI, Wouter.
- **API:** Express 5, TypeScript, Web Request/Response adapter for streaming, multipart, range, aborts, same-origin mutation protection.
- **Shared engine:** `lib/arena` contains the Waveyard DSP, library service, session service, separation broker, conversion engine, Studio, Arcade, Spaces, AI runtime, security.
- **Database:** PostgreSQL 16, Drizzle ORM, `lib/db/src/schema`, canonical migrations in `lib/arena/desktop-migrations` (`0000`–`0024`).
- **Desktop:** Electron 45, Vite, Express, embedded PostgreSQL, Windows NSIS packaging, native WASAPI capture host, Arcade native host.
- **AI runtime:** deterministic local engine (not an LLM), WebLLM browser WebGPU, tiered model selector, `/api/models`, shared `generate()` routing, honest engine labels.

### B.3 API architecture

- `artifacts/api-server/src/routes/imported.ts` is the Express adapter for the imported Next.js-style handlers.
- Handlers live under `artifacts/api-server/src/imported/<area>/...`.
- `lib/arena/src/lib/waveyard/local-context.ts` resolves the local owner in desktop/dev/test and a verified WebAuthn identity in hosted production.
- `requireUser()` returns 401 when no trusted local mode and no verified request identity exists.
- Route handlers use `withWaveyardRequestContext` for legacy signatures.
- Mutations have same-origin protection; streaming/multipart/range responses are adapted explicitly.

### B.4 Database architecture

- PostgreSQL 16; Drizzle schema split into `arena`, `identity`, `college`, `waveyard`.
- Canonical migrations include:
  - `0017_library_track_checksum_idempotency.sql`
  - `0018_waveyard_session_queue_link.sql`
  - `0019_session_swap_asset_identity.sql`
  - `0021_repair_legacy_library_track_duplicates.sql`
  - `0022_library_conversion_jobs.sql`
  - `0023_duplicate_track_metadata_preference.sql`
  - `0024_session_key_matching_state.sql`
- Waveyard tables include `wy_tracks`, `wy_source_assets`, `wy_stem_assets`, `wy_listen_sessions`, `wy_listen_session_tracks`, `wy_listen_session_swaps`, `wy_waveform_jobs`, `wy_waveform_assets`, `wy_processing_jobs`, `wy_playlists`, `wy_queue_items`.

### B.5 Desktop architecture

- `desktop/main.mjs` is the Electron main process.
- `desktop/build.mjs` builds the Windows package and native hosts.
- `desktop/database.mjs` runs canonical migrations.
- `desktop/arena-backup.mjs` provides encrypted, verified backup/restore.
- `desktop/native/` contains the WASAPI capture host and Arcade Linux gate.
- `desktop/Start-Windows.ps1` is the owner-run Windows build entry point.
- Windows packaging is currently failing at the desktop test step; installer packaging is not reached.

### B.6 AI runtime architecture

- `lib/arena/src/lib/localEngine.ts` — deterministic local engine; explicitly not an LLM.
- `lib/arena/src/lib/webllm.ts` — browser WebLLM/WebGPU integration.
- `lib/arena/src/lib/modelHub/` — runtime registry, agent bridge, model hub.
- `lib/arena/src/lib/ai.ts` — shared routing/generation path.
- `/api/models` tier catalog.
- The honesty refactor removed misleading local-engine branding; engine provenance is recorded.

### B.7 Test infrastructure

- `node:test` + `tsx` for unit/integration.
- Playwright for browser timing/acceptance (Chromium, Firefox, WebKit).
- Embedded PostgreSQL 16 for real database integration.
- FFmpeg/FFprobe for conversion and audio probing.
- CI workflows:
  - `windows-package.yml`
  - `waveyard-browser-timing.yml`
  - `windows-arcade.yml`
  - `windows-audio-isolation.yml`
  - `linux-arcade-admission.yml`

### B.8 Room registry

20 rooms are registered in `lib/arena/src/lib/arenaRooms.ts`:

`assistant`, `orchestrator`, `council`, `congress`, `spaces`, `archive-assistant`, `classroom`, `college`, `studio`, `creative`, `foundry`, `deep-agent`, `mind`, `subscriptions`, `cut-lab`, `waveyard`, `arcade`, `luma`, `market`, `device-security`.

### B.9 Waveyard subsystem map

`lib/arena/src/lib/waveyard` contains **277 files, 103 tests**. Key modules:

- `library/` — library service, session service, session logic, player logic, collections, audio backup/restore, conversion, key matching.
- `live-stem-layers.ts` — live donor replacement, tempo matching, beat offsets, key shift, pitch lock, cache budgets.
- `separation/` — four-stem separation, deep engine, claims, quality.
- `worker-local/` — local worker, broker, analysis, waveform, sections, restore cleanup.
- `conversion/` — FFmpeg conversion, idempotency, jobs.
- `capture/` — RF64, PCM signal, segments, Windows capture manager.
- `arrangement/` — automatic remix, section arrangement, preview graph.
- `studio/` — mashup, vocal chops, synth, MIDI.
- `mixer/` — EQ, dynamics, dither, inserts.
- `streaming/` — library sync, local sync.
- `voicestudio/` — voice capability/consent/job.

---

## C. Product capability audit

Evidence levels are kept separate: **Documented**, **Designed**, **UI present**, **Source implemented**, **Unit tested**, **Integration tested**, **Persistent**, **Provider verified**, **Environment verified**, **End-to-end accepted**.

| Area | Implemented | Verified here | Outstanding | Blockers |
|---|---|---|---|---|
| **Waveyard** | Library, sessions, live stem swaps, donor cache, beat/bar alignment, tempo/key matching, section offset for stem swaps, four-stem separation, conversion, capture, Studio handoff, backup/restore | Library integration 53 pass; live-stem/session 173 pass; conversion 13 pass; startup/broker 16 pass; typecheck | Section-aware **transition** cueing; real-model separation acceptance; real musical-audio pitch-lock acceptance; inter-sample overload; some donor failure paths; real-browser/device timing | No real song files, no separation model weights, no Playwright browsers, no Windows audio device |
| **Studio** | Multitrack arrangement, mixer, piano roll, MIDI, clips, automation, waveform, undo, persistence, export | Some unit/integration tests; typecheck | Deep acceptance of large audio, cross-tab editing, export correctness, real-browser recovery | No real browser/device; not audited end-to-end this turn |
| **Arcade** | Imports, browser execution, NES/CHIP-8, EmulatorJS, repository acquisition, source editing, revisions, progress backup | Unit tests; typecheck | Broad engine support, native execution, general emulation, mod loaders, build environments, progress persistence, AI-assisted modification | Paused by owner; Windows package failing; no real browser/native acceptance |
| **Spaces** | Workspaces, missions, tools, memory, shared projects, browser automation, fail-closed resolution | Unit/integration tests; typecheck | Persistent Linux-style environment, terminal/package/build execution, long-running processes, real browser acceptance | Paused by owner; no runtime acceptance here |
| **AI Runtime** | Deterministic local engine, WebLLM, tiered selector, `/api/models`, shared generate routing, engine labels | Unit tests; typecheck | Real model installation/inference, provider connectivity, streaming, cancellation, runtime compatibility | No model weights/provider credentials; WebGPU not available here |
| **Desktop** | Electron runtime, embedded PostgreSQL, Windows packaging, capture host, Arcade native host, backup/restore | Desktop tests 129 pass/9 skip on Linux; typecheck | Windows installer acceptance, packaged app audio, update path, real endpoint loss | Windows package job fails before packaging; no Windows runner access |
| **Library** | Intake, checksum, storage, search, playlists, queue, playback state, sessions, stems, analysis, conversion, backup/restore | Real PostgreSQL integration 53 pass; FFmpeg conversion 13 pass | Large-library stress, real-device sync, VBR/ABR MP3, AAC four-stem end-to-end, packaged Windows | No large real library; no Windows app |
| **Congress / Classroom / Orchestrator / other rooms** | Source implemented; room registry present | Typecheck only | Real end-to-end acceptance | Paused by owner; not audited this turn |

### Honest summary

- The **Waveyard library/session core is real and integration-tested** against PostgreSQL and FFmpeg.
- The **live-stem engine is real and unit-tested**, including failure, cancellation, cache, and pitch-lock paths.
- **Real musical quality is not verified.** Synthetic tones and mocked audio are not evidence that a mashup sounds good.
- **Real four-stem separation is not verified** because model weights are not installed.
- **Browser timing is not verified** because Playwright browsers are not installed.
- **Windows packaging is not verified** and is currently failing before packaging.

---

## D. Replit backlog recovery

### D.1 What was recovered

- **Completed task history:** 138 Replit task IDs and commit subjects recovered from `Replit-Task-Id` metadata in the full git history. This is the strongest available evidence of completed work.
- **Visible backlog:** the owner-provided task list in the handoff prompt. Titles are reproduced as supplied. No screenshots were available to mark truncated titles; none are marked truncated.
- **Suggested backlog:** the owner-provided suggested list, including duplicates.

### D.2 What could not be recovered

- The **live Replit task queue** (status, creation date, last update, agent/owner, dependencies, current disposition) is **not available**:
  - The Replit connector is unsupported in this session.
  - No Replit API token or machine-readable export is available.
  - The Replit project URL is not an API endpoint.
  - The Windows CI artifact exists but its download host is blocked from this sandbox.
- Therefore, the register below is **partial**. It does not claim to be the complete Replit queue.

### D.3 Completed task register (138 tasks)

The full table is in the appendix. Summary by Waveyard priority:

| Priority | Count | Meaning |
|---|---:|---|
| P0/P1 | 80 | Directly Waveyard/Studio/audio |
| P3 infra | 29 | Windows/backup/database/build/process |
| P4 pause | 24 | Arcade/Spaces/other |
| P3/other | 5 | Unclassified |

The completed work is substantial. It includes live stem swaps, donor cache, pitch lock, four-stem separation, conversion, capture, Studio handoff, backup/restore, Arcade imports, Spaces missions, and Windows packaging. **Completion in commit metadata is not the same as runtime acceptance.** The report marks only what was actually run in §A as verified.

### D.4 Visible backlog register

The table below preserves the owner's wording, assigns a Waveyard-first priority, and records the current disposition. "Implemented" means commit/test evidence exists; it does **not** mean real-device or real-audio acceptance.

| # | Original task (owner-provided wording) | Category | Waveyard priority | Disposition | Evidence / notes |
|---|---|---|---|---|---|
| 1 | Land live stem swaps on the beat when snap is enabled. | Waveyard live playback / DJ timing | P0 | Implemented | Beat-aligned start exists for beat/bar modes; live swap scheduling and tests cover verified grids. Browser timing acceptance is not verified here. |
| 2 | Enable bar-level DJ actions only with verified downbeats. | Waveyard live playback / DJ timing | P0 | Implemented | Performance snap requires a measured grid and never guesses bar downbeats (session-logic.test.ts). |
| 3 | Match live sections using rhythm and harmony evidence. | Waveyard live playback / DJ timing | P0 | Partially implemented | liveStemSectionOffsetSeconds maps confident, comparable sections for stem swaps; section-aware transition cueing is explicitly not implemented (session-logic.ts). |
| 4 | Prevent vocal swaps from doubling when the original vocal is present. | Waveyard live playback / DJ timing | P0 | Partially implemented | Live layer replacement ramps the original stem to zero and retires it; no explicit test for the vocal-doubling symptom was found. |
| 5 | Make uncertain half-time readings clear before beat matching. | Waveyard live playback / DJ timing | P0 | Implemented | Half/double tempo pairs stay at native pace; low-confidence evidence is handled explicitly (session-logic.ts). UI clarity not verified. |
| 6 | Keep another stem playing when tempo matching fails. | Waveyard live playback / DJ timing | P0 | Implemented | A stalled switch times out without muting or resetting the original; failed donor selection preserves the existing layer (live-stem-layers.test.ts). |
| 7 | Set safe latency limits for live stem swaps. | Waveyard live playback / DJ timing | P0 | Implemented | LIVE_STEM_SWITCH_TIMEOUT_MS = 15s; timeout is surfaced as LiveStemSwitchTimeoutError. |
| 8 | Check high-frequency mixes for inter-sample overload. | Waveyard live playback / DJ timing | P0 | Outstanding | No inter-sample/true-peak acceptance found. Output protection tests cover sample peaks, not true-peak or hardware. |
| 9 | Keep slow switches back to stems safe. | Waveyard live playback / DJ timing | P0 | Implemented | Original crossfades back and releases donor playback (live-stem-layers.test.ts). |
| 10 | Verify donor output pitch during a live transition. | Waveyard live playback / DJ timing | P0 | Implemented | Donor harmonic correction and key-shift tests exist; real musical-audio acceptance is not verified. |
| 11 | Keep beat-aligned fades accurate after tempo changes. | Waveyard live playback / DJ timing | P0 | Implemented | Aligned automatic fades and live fade edits have scripts/tests; real-browser acceptance is not verified. |
| 12 | Keep pitch consistent when the next track fades in. | Waveyard live playback / DJ timing | P0 | Outstanding | No direct test found for pitch continuity across the incoming track fade. |
| 13 | Remember each session's pitch mode after reopening it. | Waveyard live playback / DJ timing | P0 | Implemented | Commit b23558d synchronizes pitch mode across session tabs; persistence tests exist. |
| 14 | Verify left trims with beat snap and tempo sync. | Waveyard live playback / DJ timing | P0 | Outstanding | No direct test found for left-trim interaction with beat snap/tempo sync. |
| 15 | Check pitch lock with musical audio, not only test tones. | Waveyard live playback / DJ timing | P0 | Real-device / real-audio | Synthetic tests exist; no real-musical-audio acceptance in this environment. |
| 16 | Verify pitch-lock swaps keep every stem type stable. | Waveyard live playback / DJ timing | P0 | Partially implemented | Multi-channel tests exist; all stem types under real audio are not verified. |
| 17 | Keep playback responsive while local stem separation runs. | Stem separation / donor reliability | P0 | Implemented | Service test 'four-model separation keeps real library and session HTTP routes responsive' exists; it was skipped here because real model assets are absent. |
| 18 | Prevent expired downloads from restoring donor previews. | Stem separation / donor reliability | P0 | Implemented | Expired recent donors are fetched again instead of served from cache (live-stem-layers.test.ts). |
| 19 | Show the cause when real separation acceptance stops. | Stem separation / donor reliability | P0 | Outstanding | No direct acceptance found for surfacing the cause of a stopped real separation. |
| 20 | Share donor transfers across Waveyard tabs without leaking resources. | Stem separation / donor reliability | P0 | Implemented | Duplicate in-flight selections share one download; cross-tab transport tests exist. |
| 21 | Keep saved playback and stem swaps valid after a deployment. | Stem separation / donor reliability | P0 | Implemented | Migration and session swap asset identity tests exist; deployment-specific acceptance not verified. |
| 22 | Keep saved stem levels when a session reloads. | Stem separation / donor reliability | P0 | Implemented | Commit 04aff055 verifies stem mix persistence and muted-level restoration. |
| 23 | Keep parallel donors aligned after a seek during loading. | Stem separation / donor reliability | P0 | Implemented | Pause/resume and seek resynchronize buffer playback without replacing the media element. |
| 24 | Keep a library donor selected when another live swap fails. | Stem separation / donor reliability | P0 | Implemented | Parallel donor failures preserve every other stem across cancel, reject, and timeout. |
| 25 | Recover when a preloaded donor contains corrupt audio. | Stem separation / donor reliability | P0 | Implemented | A corrupt shared download is evicted so retry fetches fresh bytes without interrupting the original. |
| 26 | Keep failed donors out of reopened saved sessions. | Stem separation / donor reliability | P0 | Outstanding | No direct test found for failed donors in reopened saved sessions. |
| 27 | Check large donors before decoding their audio. | Stem separation / donor reliability | P0 | Implemented | A donor larger than the recent-cache budget is not retained or interrupted. |
| 28 | Make sure stopping separation really ends it on Windows. | Stem separation / donor reliability | P0 | Blocked / real-device | POSIX process-group proof runs on Linux; Windows process-tree acceptance is not available here. |
| 29 | Confirm separation retries and stops stay current across sessions. | Stem separation / donor reliability | P0 | Implemented | Broker and startup recovery tests cover retries/stops; multi-session Windows acceptance not verified. |
| 30 | Keep delayed stem edits attached to the song they came from. | Stem separation / donor reliability | P0 | Implemented | Concurrent per-stem patches from separate tabs preserve both edits (service.test.ts). |
| 31 | Prevent late analysis from restoring old song details. | Stem separation / donor reliability | P0 | Implemented | Commit 33c876a keeps restored-source analysis checksum-accurate and clears stale analysis. |
| 32 | Keep stale waveforms out of audio previews. | Stem separation / donor reliability | P0 | Implemented | Commit 33c876a invalidates old waveform assets and storage keys on source replacement. |
| 33 | Keep newer stem choices after an older donor finishes. | Stem separation / donor reliability | P0 | Implemented | A late download cannot override a newer selection; a newer donor cancels stale tempo preparation. |
| 34 | Confirm stem cancellation works across Firefox and WebKit. | Stem separation / donor reliability | P0 | Blocked / real-browser | Browser timing workflow installs engines in CI; this sandbox has no Playwright browsers. |
| 35 | Keep recordings recoverable when a non-default endpoint disappears. | Recording / audio devices / recovery | P1 | Implemented | Windows capture device-loss acceptance and repair tests exist; real endpoint loss not verified here. |
| 36 | Confirm endpoint-loss recordings survive an application restart. | Recording / audio devices / recovery | P1 | Blocked / real-device | Requires a Windows desktop with an audio endpoint and restart acceptance. |
| 37 | Confirm parallel donor recovery survives real session storage. | Recording / audio devices / recovery | P1 | Partially implemented | Real session storage is used in integration tests; real-device restart acceptance not verified. |
| 38 | Confirm Bluetooth playback on real iPhone and Android. | Recording / audio devices / recovery | P1 | Real-device | No physical devices in this environment. |
| 39 | Confirm pitch and tab-return audio on actual phones. | Recording / audio devices / recovery | P1 | Real-device | No physical devices in this environment. |
| 40 | Confirm phone controls remain usable during a song switch. | Recording / audio devices / recovery | P1 | Real-device | Touch emulation is not physical-device evidence. |
| 41 | Verify phone controls remain recoverable after laptop sleep. | Recording / audio devices / recovery | P1 | Real-device | Requires a phone/laptop power-state acceptance. |
| 42 | Recover playback when output protection cannot load. | Recording / audio devices / recovery | P1 | Implemented | Output-protection recovery is handled in the capture/audio manager; real output-protection failure not verified. |
| 43 | Confirm original-audio recovery checks independent of each other. | Recording / audio devices / recovery | P1 | Implemented | Missing-original recovery tests cover source, analysis, and waveform checks; independence is asserted. |
| 44 | Keep waveform recovery moving when an owner marker fails. | Recording / audio devices / recovery | P1 | Implemented | Waveform recovery tests cover owner-marker failure and retry. |
| 45 | Protect Waveyard temporary cleanup from reused process IDs. | Recording / audio devices / recovery | P1 | Implemented | Restore-upload cleanup preserves directories owned by a live API process. |
| 46 | Clean abandoned waveform owner marker files. | Recording / audio devices / recovery | P1 | Implemented | Waveform cleanup tests cover abandoned partial writes and exhausted files. |
| 47 | Confirm startup cleanup removes exhausted waveform files. | Recording / audio devices / recovery | P1 | Implemented | Startup cleanup tests cover exhausted partial waveform writes. |
| 48 | Prevent clip and automation edits from replacing another edit. | Studio / editing | P2 | Implemented | Studio async-edit and stale-save tests exist; conflict drafts are preserved. |
| 49 | Confirm conflicted Studio drafts survive a browser refresh. | Studio / editing | P2 | Implemented | Conflict draft persistence tests exist; real-browser refresh acceptance not verified. |
| 50 | Keep saved automation points inside the right project. | Studio / editing | P2 | Implemented | Automation persistence tests exist. |
| 51 | Keep an active fade stable when its settings change. | Studio / editing | P2 | Implemented | Live fade edits recompute safe cues without moving a late clock. |
| 52 | Keep simultaneous automation edits when saves finish. | Studio / editing | P2 | Implemented | Concurrent Studio edits are merged; tests cover simultaneous saves. |
| 53 | Keep Studio selections current when another tab adds a track. | Studio / editing | P2 | Implemented | Studio readiness refresh compares source and stem asset identities. |
| 54 | Confirm Studio draft recovery across supported browsers. | Studio / editing | P2 | Blocked / real-browser | Requires Firefox/WebKit acceptance; no browsers here. |
| 55 | Recover Studio edits when browser storage is cleared. | Studio / editing | P2 | Outstanding | No direct test found for cleared browser storage recovery. |
| 56 | Confirm restored Arena records can still be edited. | Studio / editing | P2 | Implemented | Restored-source analysis and waveform tests keep records editable. |
| 57 | Verify long previews in Firefox and WebKit. | Studio / editing | P2 | Blocked / real-browser | No browsers here. |
| 58 | Confirm listening clips produce audible sound. | Studio / editing | P2 | Partially implemented | Clip-donor preview test exists but requires Chromium; audible output not verified here. |
| 59 | Finish listening exports in working WebKit. | Studio / editing | P2 | Blocked / real-browser | No WebKit here. |
| 60 | Keep compressed preview limits accurate during concurrent work. | Studio / editing | P2 | Implemented | Compressed preview limits and concurrent work tests exist. |
| 61 | Confirm Studio explains overlong waveform failures. | Studio / editing | P2 | Implemented | Waveform failure messaging is covered by recovery tests. |
| 62 | Keep keyboard clip groups recoverable after failed saves. | Studio / editing | P2 | Implemented | Keyboard clip group recovery tests exist. |
| 63 | Stop rapid automation edits from exceeding the point limit. | Studio / editing | P2 | Implemented | Automation point limit tests exist. |
| 64 | Compare longer swaps with real music formats. | Audio formats / conversion / exports | P1 | Partially implemented | Real-audio benchmark scripts exist; no real music files were available here. |
| 65 | Cover variable-rate and alternate-rate MP3 library imports. | Audio formats / conversion / exports | P1 | Outstanding | No VBR/ABR-specific acceptance found. |
| 66 | Confirm AAC/M4A library imports create playable four-stem output. | Audio formats / conversion / exports | P1 | Partially implemented | Conversion engine tests cover AAC/M4A and ALAC; four-stem output from AAC/M4A not verified end-to-end. |
| 67 | Make long AAC and FLAC previews reliable or clearly report limitations. | Audio formats / conversion / exports | P1 | Partially implemented | Conversion tests cover long previews; FLAC encoder availability is environment-specific. |
| 68 | Keep complete track details after conversion. | Audio formats / conversion / exports | P1 | Implemented | Conversion tests preserve tags and cover art. |
| 69 | Warn before WAV conversion drops embedded cover art. | Audio formats / conversion / exports | P1 | Implemented | Conversion artwork tests cover attached_pic and cover-art preservation. |
| 70 | Catch cover art lost during conversion. | Audio formats / conversion / exports | P1 | Implemented | Conversion tests assert cover-art preservation. |
| 71 | Confirm queued exports keep saved donors after later changes. | Audio formats / conversion / exports | P1 | Implemented | Queued export/donor retention tests exist. |
| 72 | Ensure restored compressed audio stays byte-for-byte consistent where required. | Audio formats / conversion / exports | P1 | Implemented | Restored compressed audio consistency tests exist. |
| 73 | Confirm music starts directly in Play and Visual. | Audio formats / conversion / exports | P1 | Partially implemented | Playback start tests exist; Play/Visual start acceptance not verified. |
| 74 | Verify preserved previews in the packaged Windows app. | Audio formats / conversion / exports | P1 | Blocked / real-device | Requires the packaged Windows app; Windows packaging is currently failing. |
| 75 | Confirm startup storage blocks never overwrite existing content. | Storage / backup / recovery | P3 | Implemented | Startup storage block tests exist. |
| 76 | Back up several imported games together. | Storage / backup / recovery | P3 | Implemented | Arcade backup tests exist; Arcade is paused. |
| 77 | Confirm large source backups restore without freezing. | Storage / backup / recovery | P3 | Partially implemented | Large-backup progress/cancellation tests exist; real large-library acceptance not verified. |
| 78 | Keep listening history intact when three uploads share storage. | Storage / backup / recovery | P3 | Implemented | Concurrent upload/listening history tests exist. |
| 79 | Confirm session retries restore the right song. | Storage / backup / recovery | P3 | Implemented | Session retry tests exist. |
| 80 | Confirm a library restore works after cleanup fails. | Storage / backup / recovery | P3 | Implemented | Restore-upload cleanup failure tests exist. |
| 81 | Show users when startup cleanup was skipped. | Storage / backup / recovery | P3 | Implemented | Startup cleanup warning tests exist. |
| 82 | Confirm cancel stops the rest of a large restore. | Storage / backup / recovery | P3 | Implemented | Restore cancellation tests exist. |
| 83 | Check restore progress with very large libraries. | Storage / backup / recovery | P3 | Partially implemented | Progress tests exist; very-large-library acceptance not verified. |
| 84 | Retry restore-upload cleanup after temporary filesystem failures. | Storage / backup / recovery | P3 | Implemented | Restore-upload cleanup retry tests exist. |
| 85 | Protect files reached through restore-upload symlinks. | Storage / backup / recovery | P3 | Implemented | Symlink protection tests exist. |
| 86 | Explain when an Arena backup manifest is damaged. | Storage / backup / recovery | P3 | Implemented | Damaged-backup acceptance tests exist. |
| 87 | Keep Arena usable when a valid restore cannot be written. | Storage / backup / recovery | P3 | Implemented | Restore-failure usability tests exist. |
| 88 | Show backup contents and sizes before restoring. | Storage / backup / recovery | P3 | Implemented | Backup estimate/manifest tests exist. |
| 89 | Confirm each Waveyard backup choice in the packaged application. | Storage / backup / recovery | P3 | Blocked / real-device | Requires the packaged Windows app. |
| 90 | Confirm session controls work in Firefox and WebKit. | Cross-platform / browser | P1 | Blocked / real-browser | No browsers here. |
| 91 | Verify long-preview memory in Firefox and WebKit. | Cross-platform / browser | P1 | Blocked / real-browser | No browsers here. |
| 92 | Confirm game rollback survives native Safari on macOS. | Cross-platform / browser | P1 | Blocked / real-device | Arcade is paused; requires macOS Safari. |
| 93 | Confirm game rollback recovery on iPhone Safari. | Cross-platform / browser | P1 | Blocked / real-device | Arcade is paused; requires iPhone. |
| 94 | Run live-swap timing in installed macOS Safari. | Cross-platform / browser | P1 | Blocked / real-device | Requires installed macOS Safari. |
| 95 | Make WebKit pitch-follow match the selected speed. | Cross-platform / browser | P1 | Blocked / real-browser | No WebKit here. |
| 96 | Verify phone controls and touch interactions. | Cross-platform / browser | P1 | Blocked / real-device | No physical devices here. |
| 97 | Confirm browser settings limitations are explained. | Cross-platform / browser | P1 | Implemented | Browser limitation messaging exists in the device benchmark/limitations docs. |
| 98 | Verify playback recovery after mobile audio interruption. | Cross-platform / browser | P1 | Blocked / real-device | Requires a phone audio interruption. |
| 99 | Prove SourceForge install blockers cannot be bypassed. | Arcade / game systems | P4 pause | Outstanding | Arcade is paused under the Waveyard-first rule. |
| 100 | Find a SourceForge game package Arcade can safely install. | Arcade / game systems | P4 pause | Outstanding | Arcade is paused. |
| 101 | Show exact build requirements before Arcade blocks an installation. | Arcade / game systems | P4 pause | Outstanding | Arcade is paused. |
| 102 | Verify manual game development across browser engines. | Arcade / game systems | P4 pause | Blocked / real-browser | Arcade is paused. |
| 103 | Keep unsaved game progress available after switching games. | Arcade / game systems | P4 pause | Implemented | Arcade progress tests exist; paused. |
| 104 | Keep created-game progress safe when another tab reloads. | Arcade / game systems | P4 pause | Implemented | Arcade progress isolation tests exist; paused. |
| 105 | Let Arcade review small games inside large Codeberg repositories. | Arcade / game systems | P4 pause | Outstanding | Arcade is paused. |
| 106 | Keep an audio warning attached to the game that caused it. | Arcade / game systems | P4 pause | Implemented | Arcade audio warning tests exist; paused. |
| 107 | Keep every game unchanged when a multi-game save fails. | Arcade / game systems | P4 pause | Implemented | Arcade multi-game save tests exist; paused. |
| 108 | Keep game rollbacks recoverable. | Arcade / game systems | P4 pause | Implemented | Arcade rollback tests exist; paused. |
| 109 | Let owners save a privacy-safe Arcade run report. | Arcade / game systems | P4 pause | Outstanding | Arcade is paused. |
| 110 | Keep two sharing tabs from offering stale invitations. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 111 | Keep all shelf updates when several tab notifications arrive. | Other Arena reliability | P4 pause | Implemented | Arcade shelf concurrency tests exist; pause. |
| 112 | Keep the playlist you most recently opened. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 113 | Keep compact playback running when the phone rotates. | Other Arena reliability | P4 pause | Partially implemented | Compact listening tests exist; phone rotation not verified. |
| 114 | Keep full-screen controls clear of phone notifications. | Other Arena reliability | P4 pause | Partially implemented | Fullscreen focus tests exist; phone notifications not verified. |
| 115 | Keep keyboard controls reachable on small screens. | Other Arena reliability | P4 pause | Partially implemented | Keyboard/fullscreen tests exist; small-screen acceptance not verified. |
| 116 | Preserve background restrictions after closing full screen. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 117 | Let users stop a remote check that is taking too long. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 118 | Verify real provider outages are labelled correctly. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 119 | Let users retry TurboAgent readiness checks. | Other Arena reliability | P4 pause | Implemented | Commit 9e78199 preflights local TurboAgent readiness; pause. |
| 120 | Prove public TurboAgent URLs are rejected. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 121 | Explain local model failures before sending game source. | Other Arena reliability | P4 pause | Outstanding | Not Waveyard; pause. |
| 122 | Prevent late analysis from restoring old song details. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate of the Waveyard analysis task; implemented by 33c876a. |
| 123 | Keep stale waveforms out of audio previews. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate of the Waveyard waveform task; implemented by 33c876a. |
| 124 | Keep newer stem choices after an older donor finishes. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; implemented and tested in live-stem-layers.test.ts. |
| 125 | Confirm stem cancellation works across Firefox and WebKit. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; browser acceptance remains blocked. |
| 126 | Let users stop a remote check that is taking too long. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; not Waveyard; pause. |
| 127 | Verify real provider outages are labelled correctly. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; not Waveyard; pause. |
| 128 | Let users retry TurboAgent readiness checks. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; implemented by 9e78199; pause. |
| 129 | Prove public TurboAgent URLs are rejected. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; not Waveyard; pause. |
| 130 | Keep pitch consistent when the next track fades in. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; outstanding. |
| 131 | Remember each session's pitch mode after reopening it. | Suggested backlog | P0/P4 | Duplicate / outstanding | Duplicate; implemented by b23558d. |
| 132 | Catch one misaligned stem among otherwise aligned results. | Suggested backlog | P0/P4 | Duplicate / outstanding | New capability; outstanding. Requires alignment confidence per stem. |
| 133 | Confirm reference timing when signal evidence is incomplete. | Suggested backlog | P0/P4 | Duplicate / outstanding | New capability; outstanding. Requires honest timing fallback. |
| 134 | Calibrate pitch-lock memory in a Windows browser. | Suggested backlog | P0/P4 | Duplicate / outstanding | Blocked / real-device. Requires Windows browser profiling. |
| 135 | Explain when browser settings prevent tab sync. | Suggested backlog | P0/P4 | Duplicate / outstanding | Outstanding. Not Waveyard; pause. |

### D.5 Disposition summary

| Disposition | Count |
|---|---:|
| Implemented | 66 |
| Partially implemented | 14 |
| Outstanding | 19 |
| Duplicate / superseded | 14 |
| Blocked / real-device / real-browser | 17 |
| Real-device / real-audio | 5 |

### D.6 Duplicates and superseded tasks

The suggested list contains direct duplicates of the visible backlog:

- "Prevent late analysis from restoring old song details" = visible task 31.
- "Keep stale waveforms out of audio previews" = visible task 32.
- "Keep newer stem choices after an older donor finishes" = visible task 33.
- "Confirm stem cancellation works across Firefox and WebKit" = visible task 34.
- "Let users stop a remote check that is taking too long" = visible task 117.
- "Verify real provider outages are labelled correctly" = visible task 118.
- "Let users retry TurboAgent readiness checks" = visible task 119.
- "Prove public TurboAgent URLs are rejected" = visible task 120.
- "Keep pitch consistent when the next track fades in" = visible task 12.
- "Remember each session's pitch mode after reopening it" = visible task 13.

These should be **de-duplicated** in the Replit queue, not implemented twice.

### D.7 Genuine defects vs new capabilities vs blocked work

**Genuine outstanding defects / gaps (Waveyard-first):**

- Section-aware transition cueing is not implemented; only stem-swap section offset exists.
- Vocal-doubling prevention has no explicit test.
- Inter-sample/true-peak overload is not checked.
- Pitch continuity across the incoming track fade is not tested.
- Left trims with beat snap/tempo sync are not tested.
- Failed donors in reopened saved sessions are not tested.
- VBR/ABR MP3 import is not covered.
- AAC/M4A → playable four-stem output is not verified end-to-end.
- Real musical-audio pitch-lock acceptance is missing.
- Real four-stem separation acceptance is missing.

**New capabilities (not previously implemented):**

- Catch one misaligned stem among otherwise aligned results.
- Confirm reference timing when signal evidence is incomplete.
- Explain when browser settings prevent tab sync.
- Agent Mission Control (owner proposal; see §H).

**Blocked by environment/provider:**

- Real-device Bluetooth/iPhone/Android acceptance.
- Firefox/WebKit/Safari acceptance.
- Windows packaged-app acceptance.
- Real model inference/provider connectivity.
- Replit queue export.

**Requires real-device/hardware testing:**

- Phone controls, rotation, sleep, audio interruption.
- Bluetooth playback.
- Windows endpoint loss/restart.
- Packaged Windows audio.

**Cannot currently be determined:**

- Current Replit task status/dates/owner.
- Whether the Windows package test failure is the only remaining Windows blocker.
- Whether the old PRs contain useful Waveyard changes not already in main.

---

## E. GitHub reconciliation

### E.1 Open PRs

| PR | Title | Base | Head | Mergeable | +/- | Disposition |
|---|---|---|---|---|---|---|
| #26 | Windows-ready integration candidate (on PR #25 head 13638fe) | `arena/integration-candidate-2026-10-21` | `arena/windows-ready-integration-2026-10-22` | MERGEABLE | 4,375 / 110 | Old pre-monorepo integration; 65 commits. Do not merge. Preserve for archaeology. |
| #25 | Integration candidate: Arcade + Spaces on Waveyard 04705ab | `arena/331aa502-arena-os-canonical` | `arena/integration-candidate-2026-10-21` | MERGEABLE | 832 / 67 | Old src/ architecture; Arcade/Spaces paused. Do not merge. |
| #24 | fix(spaces): fail closed when mission fleet cannot be resolved | `arena/spaces-selected-model` | `arena/spaces-fleet-resolution` | MERGEABLE | 90 / 5 | Spaces paused. Preserve; no port now. |
| #23 | Spaces: honor selected model in default missions | `arena/331aa502-arena-os-canonical` | `arena/spaces-selected-model` | MERGEABLE | 289 / 30 | Spaces paused. Preserve; no port now. |
| #22 | Arcade: guaranteed-four rule with immutable save/reopen proof | `arena/331aa502-arena-os-canonical` | `product/arcade-rule-save-reopen` | MERGEABLE | 445 / 32 | Arcade paused. Preserve; no port now. |
| #21 | Arcade gameplay/source workshop and contained Spaces memory | `arena/331aa502-arena-os-canonical` | `product/arcade-spaces-capabilities` | MERGEABLE | 882 / 27 | Arcade/Spaces paused. Preserve; no port now. |
| #20 | Spaces: shared mission Workshop, truthful evidence and pop-out continuation | `arena/331aa502-arena-os-canonical` | `product/spaces-workshop-proof` | CONFLICTING | 469 / 44 | Spaces paused; conflicting with old base. Preserve. |
| #19 | Arcade: browser-check custom publication and retain failed game drafts | `arena/331aa502-arena-os-canonical` | `product/arcade-runtime-validation` | CONFLICTING | 644 / 23 | Arcade paused; conflicting. Preserve. |
| #18 | test(music): verify converted audio through Waveyard and Studio | `arena/conversion-batch-download` | `product/converter-waveyard-flow` | MERGEABLE | 506 / 0 | Potentially useful conversion/Studio coverage; current main already has conversion tests. Selective port only if it adds acceptance not in main. |
| #16 | perf(waveyard): release duplicate source PCM after render | `arena/331aa502-arena-os-canonical` | `replit/waveyard-memory-ownership` | CONFLICTING | 507 / 20 | Potentially useful Waveyard memory work; old base. Selective port only after re-checking current memory tests. |
| #15 | fix(coherence): Arcade truthfulness, real Waveyard playback, fail-closed agent review | `main` | `arena/331aa502-arena-os-canonical` | CONFLICTING | 60,507 / 5,388 | Diff exceeds 300 files; old architecture. Do not merge. Preserve. |
| #14 | feat(waveyard): self-service deep-engine provisioning (six-stem Demucs) | `main` | `arena/6e5aab6e-arena-os-canonical` | CONFLICTING | 4,008 / 21 | Old architecture; current main has separation provisioning. Do not merge. |
| #10 | fix: pin embedded PG16, postgres diagnostics, API hardening, capability resolver | `main` | `fix/pg-recovery-hardening` | CONFLICTING | 1,508 / 70 | Old architecture; current main has desktop runtime. Do not merge. |
| #5 | Waveyard A7: harden deep separation and retry lifecycle | `fix/db-setup-utf8-mainline` | `arena/4fa4a9aa-arena-os-canonical` | MERGEABLE | 4,041 / 272 | Old base but mergeable. Potentially useful separation retry hardening; selective port only after re-checking current broker/separation tests. |
| #3 | Waveyard A7: the deep separation engine bridge (6-stem Demucs on the durable pipeline) | `arena/01a10c30-arena-os-canonical` | `arena/a7466e3a-arena-os-canonical` | MERGEABLE | 1,996 / 172 | Old base but mergeable. Current main has deep separation; selective port only if it adds missing acceptance. |
| #1 | Add Studio: multimodal generation (WanGP bridge + ComfyUI + hosted BYOK + demo) | `main` | `arena/01a0a9b7-arena-os-canonical` | UNKNOWN | 16,731 / 9 | Very old; do not merge. Preserve. |

### E.2 Useful unmerged work

- **#18** (converted audio through Waveyard/Studio) is the most relevant to Waveyard/Studio. It is mergeable but based on an old branch. Current main already has conversion tests; port only if it adds acceptance not present in main.
- **#16** (release duplicate source PCM) is relevant to Waveyard memory. It is conflicting with an old base; re-check current memory tests before porting.
- **#5** and **#3** (deep separation retry/bridge) are relevant to separation reliability. They are mergeable but based on an old base; current main already has a separation pipeline. Port only specific retry/acceptance logic after re-testing.
- **#15, #25, #26** are large integration candidates based on the pre-monorepo `src/` architecture. They are not directly mergeable and should not be merged wholesale.
- **#14, #10** are old architecture and conflicting. Do not merge.
- **#1** is very old and unknown. Do not merge.

### E.3 Existing main implementations

Current main already contains:

- Waveyard library/session service and live-stem engine.
- Four-stem separation pipeline and local worker.
- Conversion engine with FFmpeg and artwork preservation.
- Studio handoff and automatic remix structures.
- Backup/restore and startup recovery.
- Arcade imports, NES/CHIP-8, repository acquisition.
- Spaces missions and fail-closed resolution.
- Windows packaging source and capture host.

### E.4 Conflicts and required porting

- Old PRs use `src/app/api/...` and `src/lib/...`; current main uses `artifacts/api-server/src/imported/...` and `lib/arena/src/lib/...`.
- Porting requires re-mapping routes, schemas, and tests, not cherry-picking files.
- Preserve all original branches until reconciliation is complete.
- Do not delete or force-push any branch.

### E.5 Recommendation

- **Do not merge any old PR now.**
- Keep the branches for archaeology.
- If a specific Waveyard improvement is needed, port the **smallest behavior** with a new test against current main, not the old PR as a whole.
- The next mission should be Waveyard, not PR reconciliation.

---

## F. Engineering roadmap (Waveyard-first)

### F.1 Priority table

| Priority | Area | Direction |
|---|---|---|
| 1 | **Waveyard** | Complete smart remix experience |
| 2 | **Audio engine** | Improve only what enables Waveyard |
| 3 | **Studio** | Remix editing and finishing |
| 4 | **Arena infrastructure** | Maintain what is necessary |
| 5 | **Arcade, Spaces, other rooms** | Pause major expansion |

### F.2 Milestones

#### W1 — Musical understanding

**Objective:** detect BPM, beat phase, downbeats, key, sections, rhythm, harmonic relationships, energy, instrumentation, vocal placement, and uncertainty.

**Acceptance criteria:**
- Real songs produce BPM/key/beat/downbeat/section output with confidence and explicit uncertainty.
- Downbeat is never guessed from BPM alone.
- Section labels are evidence-based; generic novelty cuts are not mislabeled as verse/chorus.
- Analysis provenance and checksums are recorded.
- Confidence thresholds are visible to the UI.

**Complexity:** high. **Dependencies:** real music files, analysis engine, model weights. **Risks:** false confidence, tempo octave errors, downbeat ambiguity.

#### W2 — Intelligent song matching

**Objective:** given two songs, determine tempo compatibility, key/harmony compatibility, section complementarity, vocal/drum/bass/melody coexistence, and likely transition quality.

**Acceptance criteria:**
- Explainable evidence for every match claim.
- Uncertainty is explicit; no superficial BPM similarity score.
- Section matching uses confident musical roles, not ordinal position.
- Vocal compatibility considers presence/placement, not just key.
- The system can refuse a transition that is technically possible but musically poor.

**Complexity:** high. **Dependencies:** W1. **Risks:** harmonic ambiguity, section mislabeling, vocal bleed.

#### W3 — Real-time stem manipulation

**Objective:** instant isolate, swap, beat/bar sync, pitch preservation, natural transitions, preview before commit.

**Acceptance criteria:**
- Live swaps land on verified beats/bars; bar actions require verified downbeats.
- Original audio continues if tempo matching fails.
- Pitch is preserved when tempo changes; pitch mode persists across sessions.
- Cancellation/stale-intent fencing works.
- Cross-tab and cross-device consistency is verified.
- Real musical-audio pitch-lock acceptance passes.

**Complexity:** high. **Dependencies:** W1, audio engine. **Risks:** browser clock drift, output protection, device switching.

#### W4 — Automated mashup creation

**Objective:** given two or more songs, propose actual playable, editable arrangements: instrumental A + vocals B, drums A + bass B, compatible choruses/verses, vocal chops, rhythmic variations, intro/build/drop/outro.

**Acceptance criteria:**
- The output is a real arrangement, not a recommendation.
- Every clip references real source/stem audio with provenance.
- The arrangement is editable in Studio.
- Tempo/pitch/key decisions are explainable.
- The result can be previewed and exported.
- A/B variants can be compared.

**Complexity:** very high. **Dependencies:** W1, W2, W3, Studio. **Risks:** musical quality, source licensing, arrangement complexity.

#### W5 — Remix and arrangement studio

**Objective:** rearrange sections, edit stems, create loops/chops, adjust tempo/pitch, apply effects, automate transitions, export.

**Acceptance criteria:**
- Edits persist across reloads and tabs.
- Conflicts are preserved, not silently overwritten.
- Undo/recovery works.
- Large audio handling is stable.
- Export is correct and includes provenance.

**Complexity:** high. **Dependencies:** W4. **Risks:** storage limits, browser suspension, export failures.

#### W6 — Musical quality acceptance

**Objective:** prove it sounds good with real music, not just BPM calculations or aligned waveforms.

**Acceptance criteria:**
- Real songs, long songs, multiple stem types, different tempos/keys.
- Realistic donor transitions.
- Long-running playback.
- Blind listening comparison against Stem.fm and a baseline.
- Documented actual results, including failures.

**Complexity:** high. **Dependencies:** W1–W5, real music, human listening. **Risks:** subjective quality, copyright, audio hardware.

### F.3 Immediate next mission recommendation

**Mission:** implement **section-aware musical matching and a playable mashup proposal** for two real tracks.

**Why:** it directly addresses the owner's north star (smart mashups) and the most important backlog item ("Match live sections using rhythm and harmony evidence"). It also forces W1/W2/W4 to work together instead of remaining isolated primitives.

**Scope boundary:** no Arcade/Spaces/Windows/backup work. No new rooms. No unrelated refactors.

**Acceptance:** a real two-track mashup proposal with explainable tempo/key/section evidence, a playable arrangement, and a Studio handoff, tested against real audio.

**Risk:** this is a large mission. It should be split into W1 → W2 → W4 vertical slices, each with a working demo.

### F.4 What waits

- Arcade expansion.
- Spaces persistent Linux environment.
- Windows packaging/capture acceptance (unless it blocks Waveyard desktop use).
- Backup manifest/restore edge cases.
- Cross-browser/device acceptance (unless it blocks Waveyard).
- Old PR reconciliation.
- Agent Mission Control implementation (design only for now).

---

## G. First implementation (completed before the new directive)

The following changes were already implemented, tested, committed, and pushed before the owner's "do not implement anything yet" instruction. They are reported here because they are the current HEAD and the only code changes in this session.

### G.1 Waveyard library integration suite migration accuracy — `20f9864`

**Defect:** the migration-0021 fixture inserted through the current Drizzle model, which includes `wy_listen_sessions` columns added by migration 0024. The fixture failed before the repair ran, so the migration test did not actually exercise migration 0021.

**Fix:**
- Insert the pre-0021 session with raw SQL using only `(id, owner_id, name)`.
- Read the repaired session through the pre-0024 columns.
- Set `NODE_ENV=test` before route modules load so the production GET route tests do not depend on the runner's ambient environment.

**Verification:**
- Real embedded PostgreSQL 16 + FFmpeg/FFprobe.
- Waveyard library integration suite: **53 pass, 0 fail, 4 skip**.
- The two registered acceptance patterns pass.
- Typecheck passes.

**Commit:** `20f9864` (pushed).

### G.2 Windows desktop test glob — `085a58a`

**Defect:** the Linux-only admission cleanup test is included in the Windows desktop test glob and can fail the Windows package job before packaging.

**Fix:** skip the four Linux cgroup/process-group cleanup tests on non-Linux platforms; keep full coverage on Linux.

**Verification:** desktop suite on Linux: **129 pass, 0 fail, 9 skip**; the guarded file still runs all four tests on Linux.

**Commit:** `085a58a` (pushed).

### G.3 Windows CI diagnostic evidence — `e906fbf`

**Purpose:** the Windows package job still fails at the desktop test step, and the hosted log receiver is blocked from this sandbox. The workflow now runs each desktop test file separately and uploads per-file evidence.

**Status:** the artifact exists but its download host is blocked from this sandbox. The Windows job still fails. This is **not a product fix** and should be removed or refined once the actual failing test is identified.

**Commit:** `e906fbf` (pushed).

### G.4 Honest scope

These are **test/CI fixes**, not Waveyard product capabilities. They restore verification and remove a CI blocker, but they do not implement smart mashups, musical matching, or real separation acceptance. The next mission must be Waveyard.

---

## H. Agent Mission Control (future capability, design only)

The owner proposed building mission discipline into Arena itself, not just as a prompt. This is recorded as a **new capability**, not a current Waveyard priority.

**Mission object:**
- Objective
- Scope
- Relevant files
- Acceptance criteria
- Allowed tools
- Time/investigation budget
- Dependencies
- Completion evidence
- Discovered-but-unrelated issues inbox

**Key rule:** discoveries do not automatically become new missions. They go into an inbox for later prioritization.

**Where it fits:** `lib/arena/src/lib/spaces` / a new `mission-control` module, with API routes and a UI in Spaces or a dedicated room. It should be built after Waveyard reaches its intended standard, unless the owner directs otherwise.

**Status:** design only. No implementation in this turn.

---

## I. Open questions / owner decisions

1. **Replit queue export:** can the owner export the task board as CSV/JSON or connect Replit? Without it, the register is partial.
2. **Windows CI logs:** the artifact/log hosts are blocked from this sandbox. Can the owner download the `desktop-test-evidence` artifact or provide the failing test output?
3. **Real music assets:** can the owner provide licensed reference tracks for real separation/mashup acceptance?
4. **Model weights:** are the pinned four-stem models installed on the target machine? Real separation acceptance is blocked without them.
5. **Priority confirmation:** confirm that Waveyard smart mashups is the sole current priority and that Arcade/Spaces/Windows/backup expansion is paused.
6. **Agent Mission Control:** should this be designed now or after Waveyard? The owner's proposal is recorded; no implementation started.

---

## Appendix — Full completed task register (138 tasks)

The table below is the recovered completed-task history from commit metadata. "Implemented" here means a commit with a Replit task ID exists; it does not by itself prove runtime acceptance.

| Date | Replit task ID | Commit | Completed task (commit subject) | Waveyard priority |
|---|---|---|---|---|
| 2026-10-27 | `a06956b0-7036-486f-8129-dca5f95483ba` | `e8c3bb3` | Add native Windows browser tasks with local-model selection and resumable approvals | P4 pause |
| 2026-10-27 | `71f20b83-0c85-4e41-970b-27fe9fa2f4bf` | `5e856f4` | Add multi-system Arcade imports, emulation, and local saves | P4 pause |
| 2026-10-27 | `5e4715af-9fd4-452b-9c2a-4cce75ab6b8a` | `9783a2f` | Switch to separated stems without interrupting playback | P0/P1 |
| 2026-10-28 | `e611dc78-b190-4135-82a1-35403703e028` | `4dd8583` | Verify real MDX stem persistence and live mixing | P0/P1 |
| 2026-10-28 | `935cc32f-fc7b-45eb-87e8-34fe4d284f45` | `6c2c469` | Run Waveyard CPU separation in an isolated worker | P0/P1 |
| 2026-10-28 | `d2eb8f7b-4cc9-4833-bb21-5ba436f024eb` | `bf5b9ca` | Prevent duplicate Waveyard tracks and separation jobs on upload retries | P0/P1 |
| 2026-10-28 | `8223c53a-2d16-43d8-813d-bb2d15010c8a` | `90aae64` | Recover pending waveform jobs after local API restarts | P0/P1 |
| 2026-10-28 | `bca7ec5c-973e-4342-9227-4722a7a81bd9` | `6bbb3aa` | Clean up orphaned waveform storage objects safely | P0/P1 |
| 2026-10-28 | `5370681d-44ad-4862-b973-c65f22c73d47` | `fa1a3c9` | Test waveform retry recovery across local worker restarts | P0/P1 |
| 2026-10-28 | `a23e7f70-6db3-495d-9963-d8a4965fc2c6` | `3b52a01` | Test waveform recovery against completion races | P0/P1 |
| 2026-10-28 | `6d959e01-6c74-41d5-90e9-3fb2592e2eba` | `aa0e134` | Test repeated waveform restarts and stabilize smoke input | P0/P1 |
| 2026-10-28 | `d492c996-2bb9-4925-bedd-5d4660631001` | `b687e6f` | Prevent duplicate waveform submissions during concurrent startup recovery | P4 pause |
| 2026-10-28 | `2ed4d364-5415-43cc-a763-ee1d9262bfe9` | `e7f6292` | Protect completed waveforms from late queue submission errors | P4 pause |
| 2026-10-28 | `5042400b-df43-4e57-97cb-0400d91464cb` | `7f15e3e` | Verify live session to Studio handoff end to end | P0/P1 |
| 2026-10-28 | `ca7bd9b4-cb7c-41a8-ae44-1c4b599703d5` | `23389da` | Add direct recovery for failed Waveyard stem jobs | P0/P1 |
| 2026-10-31 | `92e87e76-a714-4ff9-bf50-6de4fb6b2444` | `d06433a` | Add focused Arcade local-model acceptance and verify live Ollama generation | P4 pause |
| 2026-10-31 | `9c5c4c63-2c45-4367-8b64-e5d34915fc0c` | `381f88e` | Speed up and profile local Waveyard CPU separation | P0/P1 |
| 2026-10-31 | `2980645a-c545-42d9-b071-5677f518d13e` | `42dc10f` | Restore verified conversion for user-owned local audio | P3 infra |
| 2026-10-31 | `621455e0-f994-44e9-8a52-d03a56d7ec8c` | `c573533` | Add local Arcade prompt comparison for Ollama models | P4 pause |
| 2026-10-31 | `cacc60d0-0e5e-4932-9c72-147712e86971` | `b98fc1c` | Measure live stem swap preparation and audible-start timing | P0/P1 |
| 2026-10-31 | `ebf843d9-5348-4c4d-a6ea-e2871eb1d484` | `e98b517` | Reuse recent prepared audio for live stem donor toggles | P0/P1 |
| 2026-10-31 | `2cdc5474-2f90-4f12-b1c9-1eabf0756a13` | `772b05f` | Evaluate pinned four-stem separation against licensed reference tracks | P0/P1 |
| 2026-10-31 | `ca76f7b1-c0e1-4972-aea5-7f00d7bdeabb` | `8c96281` | Profile four-stem inference and default Linux to the faster measured mode | P4 pause |
| 2026-10-31 | `1a92f4eb-61a9-4a7e-8e12-c5e925586cca` | `b54297d` | Add isolated-preview Pong gameplay acceptance checks | P4 pause |
| 2026-10-31 | `948d52d2-6ca4-4464-99ec-08ca19cbd16e` | `86ea5e3` | Verify session handoff arrangements reopen with linked audio and restored mix state | P3 infra |
| 2026-10-31 | `6e0eb0f3-01bf-4804-b7ab-5d945239932a` | `30d4597` | Make Studio playback controls touch-friendly on mobile | P0/P1 |
| 2026-10-31 | `4f733e3c-86d8-4c8f-a7ab-ff934c48538b` | `727de6c` | Bound recent stem audio cache by decoded bytes | P0/P1 |
| 2026-10-31 | `105cda56-a0dc-4b48-ab37-c81f139cf9de` | `cdd9d82` | Test concurrent stem swaps under recent-donor cache pressure | P0/P1 |
| 2026-10-31 | `6f881334-2743-4ed7-8e9a-0b6a0199d127` | `84084aa` | Add repeatable paired four-stem speed benchmarks | P0/P1 |
| 2026-10-31 | `1b73e8f9-2bc4-4494-afca-d2f9d8d64b52` | `c785369` | Measure repeated four-stem native memory and serialize session release | P0/P1 |
| 2026-10-31 | `dd82feaa-e229-4120-b80f-dd2ad7e6d09e` | `8a7b1d0` | Guard Windows builds with measured disk-space preflight | P3 infra |
| 2026-10-31 | `cd1ab01d-b259-483d-8f94-09b66d96fa50` | `0bebb9a` | Add Windows x64 installed-package smoke checks | P3 infra |
| 2026-10-31 | `aa57bc4c-7f75-4cc2-b86d-10d212d6b222` | `f1069d0` | Make Apple Music metadata backups easy to reach | P3 infra |
| 2026-10-31 | `fc17ca30-0897-4a98-b49c-fd450c808f8a` | `2f2eb91` | Test multiple live stem swaps through Studio reload | P0/P1 |
| 2026-10-31 | `f442e3d5-e18d-41c0-81c0-3f4547f40ed8` | `38e07a7` | Restore visible Studio focus after keyboard session handoff | P3 infra |
| 2026-10-31 | `efe58f3e-87b6-4410-ba23-8be4c5f7210f` | `fb5d375` | Enable touch editing for arrangement clips | P0/P1 |
| 2026-10-31 | `aecd6f5c-0d4a-4c00-b080-fc56737cf5c3` | `f4acaaf` | Recover Waveyard Studio playback after foreground transitions | P0/P1 |
| 2026-10-31 | `a0bfcae8-a839-420e-ad76-8740d6f8ef35` | `8ff23b0` | Test cache limits for expanded tempo-matched stems | P0/P1 |
| 2026-10-31 | `9447a762-db1c-4dc5-9ecc-42cee526333b` | `86f26db` | Test live stem cache expiration and byte reclamation | P0/P1 |
| 2026-10-31 | `aa4ead45-c25a-44ff-a46d-8115e74613eb` | `530353a` | Add undo and accept controls for imported-game revisions | P4 pause |
| 2026-10-31 | `559032e7-41d1-45d0-bb44-f09d898c9010` | `0f83eb2` | Verify imported-game progress survives prompt revisions | P4 pause |
| 2026-10-31 | `181f3f5d-70b3-4e88-aa16-c09958b8878f` | `a45771c` | Add checksummed paired separation-quality comparisons | P0/P1 |
| 2026-10-31 | `4be799f8-a8f3-4d4c-b344-1058bd5ee04f` | `22927da` | Reject incomplete paired timing runs | P3/other |
| 2026-10-31 | `91b3eeb8-4c79-4ee3-8208-1cd529bcce26` | `159c3d9` | Add privacy-safe Windows build disk measurement checkpoints and retry comparison | P3 infra |
| 2026-10-31 | `2d79af56-ab22-47a3-b3b5-755c14ecaf70` | `97c968e` | Add encrypted, verified Arena database backup and restore | P3 infra |
| 2026-10-31 | `bac07810-8b76-487e-93b7-daa6688b4003` | `423ed6b` | Add isolated classic CHIP-8 runtime to Arcade | P4 pause |
| 2026-10-31 | `8c0526b1-c12f-4d4d-ae55-937040ca1fb6` | `001ef05` | Catch NES input, ROM-error and imported-navigation regressions; preserve import errors during emulator startup | P4 pause |
| 2026-10-31 | `450c78a3-53f1-4115-9f74-1604347789ca` | `6651dad` | Add cancellable timed live stem preparation without interrupting playback | P0/P1 |
| 2026-10-31 | `dc44b474-41c0-40e7-b0eb-a3ef53f5d763` | `bf2f68a` | Persist session full-track and stems playback choices | P0/P1 |
| 2026-10-31 | `61e7661b-d4be-4d78-b8be-6b4d6b0449c3` | `5fcc532` | Explain missing original audio while preserving stem playback | P0/P1 |
| 2026-11-01 | `a4c10095-a571-45a1-af29-b7ba3cc22b68` | `aa27d25` | Test stem controls across full-track round trips | P0/P1 |
| 2026-11-01 | `1a258b06-df27-4fc1-abbd-8077ac353b35` | `2404a9b` | Test multi-chunk four-stem responsiveness and memory | P4 pause |
| 2026-11-01 | `5285b7dc-5c5e-43b3-908a-4135b429aec6` | `f64ec2a` | Safely clean abandoned Waveyard source uploads | P0/P1 |
| 2026-11-01 | `efb7ebb9-5d9c-4560-87e3-fa8a908bc0a6` | `60a3d9a` | Verify aligned automatic fades and isolate concurrent shelf reads in smoke validation | P0/P1 |
| 2026-11-01 | `4b682c79-fe41-4454-adfe-b9a7e60740ff` | `d35c1d7` | Support scoped playlist-only session reordering without moving linked queue entries | P0/P1 |
| 2026-11-01 | `bbbeee5f-81fe-4bfa-a5d3-e3fb570df580` | `6cfe942` | Refresh Waveyard queue and session on tab resume and cover missed notices in frozen-tab regression | P0/P1 |
| 2026-11-02 | `1ef5aea4-9350-4683-9543-c0ed8ad6e718` | `cc65266` | Repair legacy duplicate Waveyard tracks while preserving listener references | P0/P1 |
| 2026-11-02 | `393e22ee-301f-4a41-8bd2-b913afe7cf32` | `488ab73` | Test waveform recovery after a database connection interruption | P3 infra |
| 2026-11-02 | `10cd9838-9aeb-406b-bad2-b0d956f10883` | `80ec3bd` | Make waveform queue failures actionable in the listener UI | P0/P1 |
| 2026-11-02 | `19d8f83a-9cdd-4c3e-94f0-840aeea3e21b` | `09abc2c` | Test waveform recovery across independent API processes | P3 infra |
| 2026-11-02 | `90c0b81f-8217-4771-bbb6-dbc5aaa03230` | `18ccc40` | Verify selected session tracks flow into Studio | P0/P1 |
| 2026-11-02 | `bb6ee8f3-ea99-4349-a933-f94ade09de0c` | `d35d652` | Verify direct separation starts from library tracks | P0/P1 |
| 2026-11-02 | `aa7fe40a-93f9-4ab1-9e98-09953fc1b856` | `1887d8f` | Persist local audio conversion jobs and resume after restart | P0/P1 |
| 2026-11-02 | `517d3915-0950-4375-b18c-4e0ca746bc52` | `1387545` | Add converted-track ZIP backup integration coverage | P3 infra |
| 2026-11-02 | `552bf4c9-ec1b-4a6d-9a83-ab3a5e3806fc` | `9db5c6d` | Preserve embedded artwork in local audio conversions | P0/P1 |
| 2026-11-02 | `33d7aa06-e23b-451d-8170-958eff0e2037` | `9cc29c2` | Add cross-browser live stem timing scenarios | P0/P1 |
| 2026-11-02 | `a6415ead-951c-4ba8-85bf-c73d16f54051` | `d1c436c` | Add a device-side comparative live stem swap benchmark | P0/P1 |
| 2026-11-02 | `4bf76958-051f-448e-9995-773b48c3bea2` | `4d08431` | Show generated game controls in Arcade play view | P4 pause |
| 2026-11-02 | `5c3d9808-592c-4ffa-bb0a-7b1372bb3123` | `31ce914` | Test native timeline touch scrolling and clip gesture isolation | P0/P1 |
| 2026-11-02 | `94162f59-1077-4745-914f-4b0089b41a7a` | `498bd28` | Verify touch Studio edits persist and report failed saves | P0/P1 |
| 2026-11-02 | `6178c7d4-c6ed-4031-910f-23e8d7388ae7` | `6ea7e12` | Add portable checks for app-loopback and system-mix fallback | P0/P1 |
| 2026-11-02 | `3e156d60-685a-46e1-a9a2-dec4d5af8cd2` | `90d53fb` | Prepare Studio mobile resume device-test checklist | P0/P1 |
| 2026-11-02 | `de0ce1d5-8e26-4637-aed9-546dfc4b5b89` | `87cd026` | Recover Studio playback from foreground audio interruptions | P0/P1 |
| 2026-11-02 | `437f2d57-ee33-4415-9be7-9ace0658d664` | `371c9be` | Test donor cache expiry and disposal lifecycle | P0/P1 |
| 2026-11-02 | `87226fb2-cfb5-41f7-a519-0eee739f3e28` | `0b7cb14` | Compare CPU-mode stems with blinded checksum-backed listening kit | P0/P1 |
| 2026-11-02 | `fffd4257-8487-4ee5-bc99-50a232abf379` | `4f88303` | Add paired multi-track CPU quality benchmark reports | P0/P1 |
| 2026-11-02 | `21d25652-6852-483c-8f05-7618ba19f65c` | `687d5ca` | Clean abandoned Waveyard restore uploads safely | P3 infra |
| 2026-11-02 | `48b1ed97-3a60-4aa1-9e5c-7a8b9cbabd59` | `7ea531e` | Separate sampled progress timings from authoritative model timings | P4 pause |
| 2026-11-02 | `797034de-b9a2-4a06-8072-8cc5c4c97781` | `b4b04d8` | Make Windows process capture searchable and grouped | P3 infra |
| 2026-11-02 | `60515e4e-75a3-4d48-84e4-e5d30080aa01` | `a179b42` | Add opt-in Windows capture lifecycle acceptance for output changes and suspend/resume | P3 infra |
| 2026-11-02 | `04aff055-f3de-44e9-991f-a7446946ddd6` | `7a84a61` | Verify stem mix persists across reloads and restores muted levels | P3 infra |
| 2026-11-02 | `59477bb2-ab8d-46af-9cd8-f5e7687d2cd3` | `70ab98a` | Test concurrent library upload retries through the API route | P0/P1 |
| 2026-11-02 | `bed7fde4-8fff-4d17-892a-eb29c49fb777` | `8b0fe63` | Test local worker orphan cleanup startup failures | P3/other |
| 2026-11-02 | `49833131-53f1-4a29-88dc-c12610b3a34d` | `4c1381e` | Test permanent waveform decode failures after recovery | P0/P1 |
| 2026-11-02 | `85a64151-93fd-4f6c-b728-ac5853faae45` | `47b202c` | Make waveform retries reuse one durable object key | P0/P1 |
| 2026-11-02 | `9697199a-b987-4c01-b557-cfdc3eed374f` | `c727eae` | Test waveform recovery with an immediately started local handler | P0/P1 |
| 2026-11-03 | `d814e558-cf43-4b5d-9df8-67eb0fc003ba` | `815c6ff` | Add isolated Windows package upgrade verification | P3 infra |
| 2026-11-03 | `c15ecbe2-f793-43cb-8f11-b108975c01fc` | `030445e` | Add opt-in local folders to encrypted Arena backups | P3 infra |
| 2026-11-03 | `596d6518-94a9-4c9f-93e2-d99d288b839c` | `58f7b5c` | Release interrupted NES controls and verify lifecycle and pointer cancellation against original ROM | P4 pause |
| 2026-11-03 | `0faffb94-d4fa-46f9-9c17-8946f7cdcba0` | `0fb93f0` | Verify visible NES gameplay state restores before and after reload | P4 pause |
| 2026-11-03 | `d1145667-4a9f-43d9-9ecf-2fd4bb0d81e2` | `706240f` | Notify session tabs of saved stem changes and verify cancelled and timed-out donors stay silent across tabs | P0/P1 |
| 2026-11-03 | `7552f33c-031e-4d1d-a22c-e5e3252432c5` | `5e8b0ed` | Restore missing original audio for stem-only session tracks | P3 infra |
| 2026-11-03 | `c25a190e-f33e-4fef-ae30-120eab9d8476` | `ab20b90` | Expose missing-original status and stem actions in compact listening | P0/P1 |
| 2026-11-03 | `645f6fbc-fee4-49e3-bb08-0ba2214ddf30` | `f788120` | Add focused browser regressions for delayed session playback-mode acknowledgements | P0/P1 |
| 2026-11-03 | `df7521b4-b73f-4595-b80a-485de0bf348b` | `95e4dfa` | Add Windows four-stem memory measurement reporting | P3 infra |
| 2026-11-03 | `685173a2-013d-43a1-9ed4-3e444cff0347` | `b3d3b5e` | Test source upload safety during cleanup across API instances | P3/other |
| 2026-11-03 | `7b60487b-9319-4fad-9b48-95cc2800c6bc` | `782c9d4` | Measure separation memory across repeated and changing excerpts | P0/P1 |
| 2026-11-03 | `84a2b89b-fc0b-497a-93aa-bcfb37db347a` | `c5deeb2` | Resolve npm cache offline and include its volume in Windows build disk safeguards | P3 infra |
| 2026-11-03 | `c452b18a-e4d9-401b-b1f0-da6462b21ebe` | `41f82e2` | Use resolved storage paths for Windows build preflight and disk sampling | P3 infra |
| 2026-11-03 | `e46e5820-c94e-4b9d-a6ca-de2b4caa3d78` | `ba3cbce` | test(waveyard): prove saved vocal and drum donors render at persisted levels | P0/P1 |
| 2026-11-03 | `b7a6202c-54c9-45ff-a4a9-a07ad68a7d95` | `7c23bb8` | Test isolated live donor decode failures and valid in-page retry | P0/P1 |
| 2026-11-03 | `aa323635-b879-4de3-b208-57c51b6866e1` | `aadbf9c` | Add anchored keyboard clip ranges, scoped selection toggles, accessible counts and group-edit regression checks | P0/P1 |
| 2026-11-03 | `96eecd08-3f20-40c7-872e-a5c6555ea901` | `fd8ea2d` | Add accessible Studio automation point editor and focused keyboard regression | P0/P1 |
| 2026-11-03 | `832fcbde-b51c-4c3c-95cc-319677d70f15` | `88f6322` | Keep fullscreen Play and Visual keyboard focus visible and contained; add isolated regression checks | P0/P1 |
| 2026-11-03 | `794a4174-613b-4f07-a982-51553fac539c` | `5b6e561` | Preserve Studio audio across view switches and add focused native browser continuity checks | P0/P1 |
| 2026-11-03 | `93cee85a-4458-46c9-aa99-4b139f48e1cf` | `a5ac894` | Recover imported game shelf changes across tabs, including missed focus refreshes | P4 pause |
| 2026-11-03 | `7ae06cc7-09f0-410f-ae22-f9ad9914689e` | `93c286f` | Verify live fade setting edits and delayed browser cues; prevent warning rearming from setting changes | P0/P1 |
| 2026-11-03 | `d6317df1-ccc4-4bd5-8f5a-fd7817521d9a` | `1922178` | Coordinate Waveyard queue and session ordering transactions, reject stale UI moves, and cover real database concurrency | P3 infra |
| 2026-11-03 | `eee31f89-81a9-4aa8-a40b-666fa7b03a8e` | `5c8c93b` | Add portable local HTML source backups with retained revisions and safe confirmed restore | P3 infra |
| 2026-11-03 | `bccc1f57-0e5d-4198-8a9c-8fb376299b0a` | `b07ef4c` | Verify game revision rollback persistence in Playwright WebKit | P4 pause |
| 2026-11-03 | `e6b05558-a616-46f5-854c-3193c0034307` | `90638d5` | Protect restored game progress from stale tabs | P4 pause |
| 2026-11-03 | `5b3c0b98-9ddb-42c0-b924-41236696d36a` | `2863daf` | Verify HTML progress backup recovery in Playwright WebKit | P3 infra |
| 2026-11-04 | `36037207-6162-4a97-b485-c2f1642c0cbc` | `35ef895` | Recover Studio edits interrupted before autosave | P0/P1 |
| 2026-11-04 | `a05c222b-93f9-433e-ae0a-e4cc78234264` | `afd822b` | Reject stale Studio arrangement saves and preserve conflict drafts | P0/P1 |
| 2026-11-04 | `711c2e02-db97-4754-b429-c176e71c3417` | `6583714` | Fix clip-donor Studio preview transport and add browser regression coverage | P0/P1 |
| 2026-11-04 | `cf1a7608-853f-47aa-a21d-4b42090470d8` | `5ac5cdf` | Harden waveform recovery against malformed claims | P0/P1 |
| 2026-11-04 | `4b98139f-37dc-48b5-895c-d9516b973906` | `2fbc18d` | Compare Waveyard device benchmark reports | P0/P1 |
| 2026-11-04 | `a030c04c-217e-4b3f-8913-674a5d718a6e` | `33fc236` | Compare phone stem swaps across short and longer donors | P0/P1 |
| 2026-11-04 | `600b70c3-a7b6-4d1f-847f-4a1e233c06e3` | `02e389d` | Verify generated game controls against playable inputs | P4 pause |
| 2026-11-04 | `9b6efa2b-da2f-4c57-8ee7-32680f904eec` | `2eba1db` | Verify mobile pitch modes and record browser limitations | P0/P1 |
| 2026-11-04 | `db920f00-df9a-423c-8859-c3edf4f2440d` | `cf674bd` | Add private preview playback for preserved recordings | P3/other |
| 2026-11-04 | `1a0ebab8-c6b8-41e5-ba6e-d402f90483ac` | `2641fe7` | Add Windows capture device-loss acceptance and repair live-stem retries and smoke selectors | P3 infra |
| 2026-11-04 | `34cb7b35-85f6-46f4-ad1d-1d862c89734e` | `b047ac6` | Test compressed donor preview expiry and byte accounting | P0/P1 |
| 2026-11-04 | `fe3d5ee5-e103-44d6-bcbf-ef2de02ecf00` | `233840c` | Record blind-listening browser checks and WebKit runtime limitation | P3/other |
| 2026-11-05 | `2f220c3e-f194-417c-9ab5-fc6ed68c5871` | `0d45457` | Verify damaged Windows Arena backups cannot replace active data | P3 infra |
| 2026-11-05 | `ec7d3d6a-11a8-4864-af7e-d9ac218e9624` | `b77cb64` | Explain Arcade save failures and verify recovery | P4 pause |
| 2026-11-05 | `6ca3bbb7-7a29-4d44-bcf5-2c32ea57937e` | `64132ee` | Virtualize the Waveyard process picker and verify the 8,192-entry limit | P3 infra |
| 2026-11-05 | `787fbf64-cae8-41c2-8afc-7c7638d08a4c` | `43287b9` | Test cleanup after exhausted partial waveform writes | P0/P1 |
| 2026-11-05 | `ddd2ae25-701a-4954-b9c3-52a31d08ddaa` | `8ae936d` | Enforce shared Waveyard pitch-lock PCM budget | P0/P1 |
| 2026-11-05 | `f8b2fc4a-7532-4ba7-8d76-f926478d76f0` | `c64859d` | Prevent duplicate waveform deliveries from failing completed jobs | P0/P1 |
| 2026-11-05 | `f43c6cdf-6b43-42b2-8ca2-fe5da328b5d6` | `394b1fb` | Test recovery of interrupted waveform finalization | P0/P1 |
| 2026-11-05 | `4607a996-bc0d-4df7-972d-8f99d5946c14` | `e499032` | Detect time-shifted Waveyard reference stems before quality scoring | P0/P1 |
| 2026-11-05 | `49d05de4-c870-400f-bd3d-f5d9905a1d7f` | `b23558d` | Synchronize pitch mode across Waveyard session tabs | P0/P1 |
| 2026-11-05 | `f3613b27-8f31-45eb-ac10-37850d4de997` | `9e78199` | Preflight local TurboAgent readiness before Arcade game requests | P4 pause |
| 2026-11-05 | `76752c23-1b22-4837-8d26-a4cf122ad12f` | `5a4c24f` | Add explicit ephemeral remote model checks for Arcade | P4 pause |
| 2026-11-05 | `d9bf21a8-4062-4eb5-9902-769100b9cf78` | `635e314` | Show backup estimates and progress with safe cancellation | P3 infra |
| 2026-11-05 | `cfd1517b-4699-4212-8c49-0c9bdb6e1626` | `dade20d` | Add storage-fallback cross-tab stem recovery coverage | P0/P1 |
| 2026-11-05 | `c2bd230a-de18-4a1f-af26-fca8541325b5` | `33c876a` | Keep restored-source analysis and waveform data checksum-accurate | P3 infra |

