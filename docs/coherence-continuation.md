# Product coherence continuation — 2026-10-18

Bounded delivery: Arcade request routing, generation/iteration truthfulness, and result retention. This is not whole-product or desktop acceptance.

## Fixed paths

- Auto + unknown mechanics → genuine model code generation (online when permitted, otherwise on-device), never implicit Neon Arena. Instant + unknown mechanics → actionable error. Explicit template selection remains available.
- Removed broad `space`, `ghost`, `blocks` keyword routes which misclassified unrelated mechanics.
- Model unavailable / invalid output → error, previous playable game retained. Iteration retains its instruction on failure and passes the full current HTML to code generation instead of regenerating a template.
- Repair receives the failed draft. Deterministic repair fallback fails; accepted repair provenance reflects its executor.
- Template bytes are checked before persisting verified/remix labels. Server codegen honors Ephemeral and exposes persistence failure. Unsaved generated HTML remains downloadable.
- Failed copy/delete/open no longer displays false completion or silently removes local state. Server-generated games no longer display a verified-core badge. Offline/online descriptions now match routing. Stop is shown only during cancellable on-device token streaming, not for an uncancellable server request.

## Evidence

- Typecheck: passed.
- Production build: passed.
- Full lint: 0 errors, 45 warnings.
- Arcade/game suite: 21 passed, including real embedded PostgreSQL create/reopen/provenance and real route rejection paths. Controlled model tests exercise generation/iteration/repair contracts, NOT real model quality or generated gameplay.
- Combined Arcade/game + Waveyard deep/retry run before the last added repair test: 42 passed.
- `test:desktop`: output ended with 137 passed / 0 failed. The tool wait timed out at 180 seconds; final summary was subsequently read from its log and no test process remained. These are automated desktop/service tests, NOT an Electron UI acceptance run.
- `desktop:smoke`: shell compiled, Electron binary acquisition failed (`fetch failed`); no renderer/IPC acceptance result exists.
- Dependency installation used `--ignore-scripts`; embedded PG initially lacked hydrated library symlinks. Running its packaged `scripts/hydrate-symlinks.js` from its own package directory enabled the real PostgreSQL route tests. No product code change was needed for that test-environment issue.

## Remaining acceptance / continuation

1. On a desktop-capable host, run Electron with isolated data, create genuinely different novel games with a reachable model, play each in the existing sandbox iframe, request gameplay changes, reopen revisions, and verify save/download/recovery. No real model execution, semantic fulfillment, browser interaction, or generated gameplay acceptance was demonstrated here.
2. Generated HTML validation remains structural, not a proof of JavaScript execution or gameplay correctness. Safe iframe remains `sandbox=allow-scripts`; stronger runtime validation remains outstanding.
3. Arcade history-fetch errors still degrade to an empty/stale list; generation persistence retries and server generation cancellation/progress are not implemented. On-device model loading cannot be cancelled by the stream Stop control. Do not advertise those as supported.
4. Waveyard provisioning PR #14 was inspected (files + evidence), not merged or duplicated. It explicitly records that genuine Demucs inference was not executed due to checkpoint/PyTorch download restrictions. This checkout's worker routes deep jobs through `runDeepSeparation`; passing injected-engine tests is not six-stem inference evidence. Owner-machine source → inference → valid/listenable stems → restart/retry/cancel acceptance remains open.
5. No claim is made about all controls, agent orchestration, other rooms, Windows installed-app acceptance, or whole-application coherence. Continue from actual execution paths, not this note as proof.

## Continued delivery: Waveyard playback + fail-closed draft review

The scope remains the whole application. Waveyard and Arcade are the first checkpoints, not completion of the mandate. Waveyard's acceptance target is the relevant STEM.FM experience for user-provided music (import, independent stems, multi-track sessions, manipulation, durable work and exports), not just Demucs. The STEM.FM benchmark here comes from the owner's supplied documentation excerpts; those external pages were not independently fetched from this network-restricted sandbox.

### Execution path and repairs

`ProjectWorkspace → StudioCore → useStemTransport` and `TrackPlayer / SessionExperience.SessionDeck → useStemTransport` share the same HTML media/Web Audio primitive. The transport now:

- Uses synchronous playback position for seek/play and loop wraps rather than a stale render closure; loop wraps keep the clock running.
- Treats equal asset-ID lists as the same deck, preventing polling from tearing down a playing context. Real deck changes pause and disconnect old channels without poisoning the context.
- Reconnects actual remounted media elements, applies pre-play master insert state, and clears playing state when audio ends.
- StudioCore mixer/insert restoration effects now depend on stable transport callbacks, not the newly returned transport object on every position tick, avoiding unnecessary graph rebuilds while playing.
- Refuses empty/missing/invalid stem playback, stops the performance if a required stem disappears/fails, and invalidates late async starts on pause/stop.

`Deep Agent page → /api/deep-agent → runDeepAgent → generation/review → deep_agent_runs/deep_agent_steps` had two false-success mechanisms: missing review verdicts defaulted to PASS; the loop marked the run done despite failed reviews and fed rejected drafts downstream. Both are fixed. Missing/deterministic-fallback reviews fail closed, rejected work stops dependent steps, exceptions mark the durable run failed, and failed transcripts remain retrievable. Page request failures now surface errors instead of clearing prior results or silently removing local entries. This is still a research/draft agent: **model review is not independent execution evidence, and no new investigative tool executor has been integrated**.

### Runtime evidence

- Browser acceptance: `npm run test:acceptance:transport`, **10 passed** with Chromium 153.0.8010.0. Uses the actual React hook, real HTML audio elements, Web Audio graphs, analyser RMS and MediaRecorder/decodeAudioData. Two deterministic PCM tones are test inputs, not alleged inference outputs.
- Checks include actual gain/mute/solo signal changes, seek alignment, repeated looping, equal-list refresh, new-deck playback, missing stem failure, pre-play master effects, ended state, remounted sources, pending-start cancellation, failed-media recovery and a decodable/non-silent master recording.
- Controlled regression comparison: the first eight browser cases against the original HEAD transport passed **1 and failed 7**; the repaired transport passed all eight. Two further recovery/recording cases were added afterward and the final suite passed all ten. The source was restored immediately after comparison; no original user changes were discarded.
- Browser TAP output includes the exact transport source SHA-256, browser version, input identity and explicit limitations. CI now installs Chromium, runs this gate on pushes/PRs, and retains TAP evidence even on failure. The added CI job has not itself been observed running here.
- `123` tests passed in the combined Arcade + Waveyard library + Deep Agent regression command, including real embedded PostgreSQL library/session persistence and PGlite draft-review transcripts. The initial library run failed because `npm ci --ignore-scripts` left PG symlinks unhydrated and ffprobe non-executable; dependency-local setup was repaired and the complete command rerun successfully. No product dependency discovery was changed to mask those failures.
- Existing Wave 3/3b integration suites: **12 passed, none skipped**, against a temporary real PostgreSQL instance booted through the desktop runtime config/EmbeddedPostgres classes and canonical migrations, then stopped and removed.
- Typecheck and production build passed. Full lint: **0 errors, 46 warnings** (one added effect-synchronisation warning in the transport).
- No Electron UI, packaged Windows, real model generation or Demucs inference acceptance has been established. Browser audio measurements are not subjective listening evidence or sample-perfect sync guarantees.

### STEM.FM-oriented acceptance status (not a completion checklist)

| Area | Evidence in this delivery | Still required |
| --- | --- | --- |
| Import/preparation | Existing service suite reads real WAV metadata, checksum, private storage and persisted track/job rows | MP3/M4A/FLAC UI import + actual separation + existing-stem import acceptance |
| Independent playback | Real graph gain/mute/solo/seek/loop/failure recovery verified with PCM tone inputs | Separated music through full room UI and Electron; subjective listening and long-duration drift |
| Multi-track sessions | Existing real SQL tests cover ordered tracks, saved mix/transitions, swaps with provenance and Studio handoff references | Audible cross-track mixing/transitions + navigation/restart continuity in the actual UI |
| Manipulation | Shared transport looping + restored master gain insert verified as signal operations | Full timeline, speed/pitch/key/edit/effect acceptance against persisted arrangements |
| Durable work/export | SQL playback/session reopen and master recording primitive verified | Full room save/restart/reopen; WAV stem export and rendered combined mix import/reopen |
| Inference | No new inference evidence | Source → intended Demucs → validated/listenable stems → workspace/session → export |

### REA reference and application-wide continuation

Inspected `morluto/rea` at `7c458f04b9155707c8ba406f8b455b10016f1b99`: MIT metadata, `src/domain/evidence.ts`, `src/application/EvidenceInputResolver.ts` and its tests. Relevant actual contracts separate observed/derived/inferred confidence, authority, source digest, environment, limitations, links and exact retained-reference resolution; dangling or mismatched references fail rather than being guessed. No REA code or dependencies were imported. This delivery applies those principles to test provenance and fail-closed review; it does **not** claim REA-like runtime investigation, tracing or retained-evidence tools are now agent-executable.

Arena already has `repoMap.ts` (bounded static file/export map), `toolRuntime.ts` (grant-scoped read-only filesystem/git tools), Archive evidence references and Deep Agent persisted transcripts. These are different contracts, not an integrated investigation-to-implementation agent. Reuse them rather than introducing a competing registry. Native/IPC observation, reusable investigative evidence and actual agent-mediated implementation/verification remain open.

The room scope was rediscovered from `Nav.tsx`, `arenaRooms.ts`, `ArenaRoomsDirectory.tsx` and `src/app/**/page.tsx`, not restricted to Waveyard/Arcade. Existing room catalogues are not acceptance evidence. No other room is promoted to accepted by this delivery, including Deep Agent (only its review-state guarantees were repaired).

Next concrete work: use the browser acceptance environment to exercise the actual local-first Waveyard room from user source import through persisted session playback and exported audio, with isolated data; complete the corresponding Electron check on a capable host and real Demucs on a prepared host. Then continue room-level execution checks using the existing directory/route map. `StudioCore` restoration-effect dependencies were corrected in this patch; full room interaction acceptance of saved effects still remains outstanding, and hook acceptance must not be treated as room acceptance. Do not reset this investigation or claim parity from the table above.

## Execution-reset continuation — listening session → usable Studio arrangement (2026-10-18)

### Repository reconciliation

Refreshed `main` (`f0e4180`) and PRs #14/#15. The snapshot initially showed the
already-published #15 files as dirty against the old base. Compared every one
of the 20 files byte-for-byte with remote `58121d7` before advancing the local
index/HEAD with a mixed reset; no worktree bytes were discarded or duplicated.
Both PRs were open, with all their reported checks successful (including #15's
browser-audio gate). Those statuses describe the **previous** heads, not this
new patch. No PR was merged or closed.

Read #14's 17-file diff and provisioning/dependency documentation. It is a
separate consent/managed-runtime prerequisite, not an inference result. This
patch does not duplicate it or integrate it on green CI alone. Its checkpoint
host (`dl.fbaipublicfiles.com`) and CPU-wheel index (`download.pytorch.org`) are
outside this sandbox's permitted outbound hosts. Current Python is 3.11.2;
`torch`, `torchaudio`, `demucs`, the managed environment and local models are
absent. No install, checkpoint download, consent, real Demucs invocation or
music-quality acceptance is claimed. Licensing assertions in that PR still
need review against actual upstream terms; do not treat them as verified here.

### Defect and implementation

`sendSessionToStudio` previously selected only the first real stem per song,
created no clips, and committed the new project/remix outside the track
transaction. The derived project owned no assets, so project GET returned no
stems and `ProjectWorkspace` could not mount Studio. Arrangement PUT and the
actual WAV renderer rejected the referenced library audio as out-of-project.
The old test checked IDs/count only, not a usable arrangement.

The handoff now:

- Keeps all separated lanes (or one explicitly selected unseparated bridge,
  never the bridge mixed on top of separated stems).
- Creates sequential, duration-bounded clips in listening order and preserves
  saved per-stem levels. Timed donor swaps become real source-range clips.
- Atomically creates project, remix, lanes and clips. Empty/oversized sessions
  are refused before writes; missing/short swap assets are refused by song.
- Enforces the existing shared 32-lane/256-clips-per-lane editor limits rather
  than creating arrangements the save/version parser cannot accept.
- Resolves project-native audio plus already-bound remix/clip/immutable-version
  references through `projectAudio`. Assets and source records must still
  belong to the destination project's owner. Arbitrary other-project clip IDs
  are not granted merely because the current user owns them. No audio files
  or source/stem rows are copied or reparented.
- Uses that resolution in workspace reads (including existing analysis and
  waveform metadata), remix reads/saves, creation, version restore and the
  desktop WAV renderer. Immutable versions retain reuse after live lanes
  have been removed/replaced.
- Shares the handoff result type with the client, fixing the old `refused`
  string-versus-array mismatch. A visible notice and persisted project
  description explain that **live transition triggers/crossfades and the
  playback cursor are not reconstructed**. This is a sequential derived edit,
  not a claim of performance-session fidelity.

### Repeatable evidence

```sh
# Normal npm install scripts hydrate the packaged PostgreSQL libraries.
# If dependencies were installed with --ignore-scripts, run the package's
# scripts/hydrate-symlinks.js from its own package directory and restore the
# ffmpeg/ffprobe platform executables' execution permission first.
WAVEYARD_ACCEPTANCE_ARTIFACT_DIR=.data/acceptance/waveyard-handoff \
  npm run test:acceptance:handoff
```

This uses the existing library service suite: a fresh embedded PostgreSQL
cluster, canonical desktop migrations, isolated storage, actual route handlers,
actual desktop local-job broker, actual FFmpeg rendering/FFprobe decoding and
actual streaming download responses. It does **not** launch Electron or a room
UI. The inputs are explicitly synthetic PCM-tone fixtures, not alleged Demucs
results. Test fixture engine metadata now says `synthetic-test-fixture`.

The suite checks all five lanes and six clips (including the timed swap),
project assets needed to mount the editor, individual stem download bytes and
non-silent decoding, save/reopen with changed master level, rejection of an
unbound same-owner asset without damaging the saved edit, version creation,
WAV export queue execution, download/decoding, restoration from immutable
versions after deleting live lanes, and survival after deleting the original
listening session. Additional cases cover the explicit source-only bridge,
empty/foreign-owner/lane-limit refusals, genuine PostgreSQL-trigger write
failure rollback, foreign-owner bound-reference exclusion, and malformed
legacy snapshots. These are route/service/render tests, not browser clicks.

Observed exported WAV: **5 seconds, 44,100 Hz, stereo PCM16**. Decoded magnitude
at 220 Hz before swap ≈ **0.05179**, at donor 880 Hz after swap ≈ **0.05179**,
next song at 880 Hz ≈ **0.03237**; unwanted donor before swap, original drums
after swap and muted vocals each **< 0.000001**. This checks real signal and
timeline content, not merely HTTP success, file existence or a nonzero RMS.

`handoff.json` retains observed time, exact implementation file SHA-256 values,
Git head **and dirty status** (so a pre-commit run cannot misattribute its
source), runtime/version, actual input digests, durable job/export provenance,
decoded signal measurements and limitations. The output WAV and individual
drum WAV are retained alongside it. CI's existing test step now retains these
artifacts **and full test output even on failure**. Generated outputs remain
outside Git. The new CI run must be observed separately after publication.

### Still not accepted

This repairs a previously unusable handoff and exercises its save/render path;
it does **not** establish full Waveyard acceptance, STEM.FM/STEM DAW parity,
model inference, subjective audio quality, Electron/Windows operation, or
browser-room navigation/restart behavior. Some advanced source-analysis actions
(section placement, meeting-point application, alignment and project-derived
processing) still enforce project-native provenance independently; carry the
same authorized-reference semantics through those paths with their provenance
tests rather than loosening every `projectId` comparison. Live transitions need
a separately defined and persisted timing contract before claiming faithful
handoff. Real-provider Arcade playability, agent-dispatched investigation and
the whole-room acceptance inventory remain open; prior text-review fixes do
not satisfy those requirements.

### Verification of this patch

- Final handoff/library integration run: **26 passed, 0 failed, 0 skipped**.
  Temporarily substituting only the original `58121d7` handoff implementation
  into the same final suite produced **22 passed / 4 failed** (bridge clips,
  multi-stem/render workflow, lane-limit refusal, atomic rollback). Repaired
  source bytes were restored in `finally` and the final suite rerun green.
- Focused remix/versioning/render-helper/session-logic tests: **33 passed**.
- Local worker suite: **42 passed, 0 failed, 0 skipped**; the initial 180-second
  tool wait expired, but the same process finished at 182.4 seconds and its
  final summary was read afterward. It was not launched twice. Includes real
  ONNX Runtime with a hand-built identity model and controlled deep-engine
  cases; **neither is learned Demucs/music-separation acceptance**. Some tests
  overlap the focused invocation above; do not sum them as distinct cases.
- Final production build and typecheck: **passed**. Full lint: **0 errors,
  46 existing warnings**. `git diff --check`: passed.
- Logs retained outside Git under `/home/user/arena-handoff-*.txt`; generated
  manifest/mix/individual-stem files under `/home/user/arena-handoff-evidence/`.
- No browser-room, Electron, packaged Windows, provider-backed Arcade, or
  agent-dispatched investigation acceptance was executed in this patch.
