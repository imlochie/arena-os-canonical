# Arena handoff — read this first

## Current verification update — 2026-11-11, mashup render and persisted-route assertions

* **Hardening:** Added `scripts/waveyard-mashup-route-acceptance.test.mjs` as a path-safe Node test entry point for the production mashup route acceptance. Passing the literal `[id]` route path directly to `tsx --test` silently discovers zero tests; the wrapper imports that exact route test so its database-backed test is registered. Corrected the route test's tone-energy helper to accept seconds, matching its call sites; its previous millisecond conversion made the audio measurements inspect only the first two milliseconds and produced a false failure.
* **Render evidence:** The production route test now checks the planned vocal placement, successful separated-vocal use, each expected instrumental-bed component, exclusion of the bed's vocal stem, no lead vocal before its arranged entry, and lead-vocal energy above 80% of the measured source through the arranged passage.
* **Persisted evidence:** The PGlite save/reopen and analysis-selection tests passed 2/2. The production route acceptance passed 1/1 against temporary migrated PostgreSQL, verifying real API rendering and save behavior, persisted remix rows and clips, pending-separation retry provenance, malformed-stem rejection, and separated-bed output.
* **Route documentation:** Corrected the route header to distinguish read-only plan/render requests from the explicit save action, which persists remix records without modifying source tracks or stems.
* **Verification:** `pnpm --filter @workspace/scripts exec tsx --test "$PWD/scripts/waveyard-mashup-route-acceptance.test.mjs"` passed 1/1; `pnpm --filter @workspace/scripts exec tsx --test "$PWD/lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts"` passed 2/2; `pnpm --filter @workspace/scripts exec tsx --test "$PWD/lib/arena/src/lib/waveyard/studio/mashup.test.ts"` passed 15/15; `pnpm --filter @workspace/api-server run typecheck` and `git diff --check` passed. The direct-path zero-test behavior was confirmed and is no longer the documented invocation.
* **Files changed:** `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`, its route test, `scripts/waveyard-mashup-route-acceptance.test.mjs`, and this handoff.
* **Remaining limitation:** These generated-tone fixtures establish route, rendered-component, and persistence behavior; they do not establish source-separation quality or subjective mashup listenability with real music.

## Current verification update — 2026-11-11, mobile timeline touch-scroll validation

* **Hardening:** The Arena smoke test now chooses a touch start inside the intersection of the visible clip, timeline scrollport, and viewport; it validates the exact hit target and dispatches that exact point away from trim/move controls. This avoids rounding a valid clip point onto a `touch-action:none` trim handle. Failed swipes capture the actual touch/pointer target and effective touch-action path.
* **Regression evidence:** The phone-sized horizontal timeline swipe passed while confirming the slider value and clip position stayed unchanged. This corrects a false test failure; no application runtime behavior changed.
* **Verification:** The configured `test` command was run directly and exited 0. `node --check scripts/arena-smoke.mjs` and `git diff --check` passed. The live-stem timing matrix passed in Chromium; WebKit and Firefox were skipped because their Playwright browser binaries are absent.
* **Files changed:** `scripts/arena-smoke.mjs` and this handoff. Agent memory also records the exact-coordinate touch-test constraint.
* **Remaining limitation:** Chromium CDP touch emulation is not physical Android/iOS testing. This verification does not establish native-device scrolling or Windows packaged-app behavior.

## Current verification update — 2026-11-11, retain completed donor stems during retries

* **Hardening:** Mashup donor lookup now joins stems to completed separation jobs in one query and verifies the job belongs to the requested project and source. A newer queued/running/failed attempt no longer hides a usable stem from the last completed run; incomplete stems remain excluded.
* **Regression evidence:** The production API acceptance test stores a newer running vocal-separation attempt and a newer stem row, then proves the saved remix still references the prior completed vocal stem and never persists the unfinished one.
* **Verification:** API-level embedded-PostgreSQL route acceptance passed 1/1; focused Waveyard mashup/analysis tests passed 44/44; library and API-server typechecks passed; `git diff --check` passed. Full workspace typecheck was not run.
* **Files changed:** `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`, `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts`, and this handoff.
* **Remaining limitation:** This protects the last completed donor through retries; it does not establish perceptual mashup quality or validate that separation output is musically clean.

## Current verification update — 2026-11-11, persisted mashup section provenance

* **Hardening:** `loadSourceProfile` now supplies section boundaries to mashup planning only when a completed section-analysis row belongs to the current project/source analysis and source checksum, uses the current desktop section engine version, and its section rows match the same analysis, checksum, and engine provenance. Section bounds outside the source duration are ignored. Missing or stale section evidence remains an empty section list rather than a fallback to unverified labels.
* **Regression evidence:** the PGlite acceptance test persists old-version, stale-checksum, current, and out-of-duration section rows and proves only the current in-range section reaches the mashup profile.
* **Route acceptance:** the production mashup-route test now saves and verifies the remix while the completed separation run exists, then removes the already-verified remix before deleting the run for the fallback-render check. The previous ordering attempted to save after deleting the required stems and also violated the clips-to-stems foreign key; the route itself correctly rejected that invalid save.
* **Files changed:** `lib/arena/src/lib/waveyard/studio/mashup-sources.ts`, `lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts`, `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts`, and this handoff.
* **Verification:** focused Waveyard mashup/analysis suites passed 44/44; the API-level embedded-PostgreSQL mashup route acceptance passed 1/1; `pnpm run typecheck:libs` and `pnpm --filter @workspace/api-server run typecheck` passed. Full workspace typecheck was not run.
* **Remaining limitation:** these checks verify provenance and persisted workflow correctness, not subjective audio quality or whether automatic section labels correctly describe verse/chorus form.

## Current verification update — 2026-11-10, end-to-end mashup route integration, multi-stem arrangements, and database round-trip acceptance

* **Highest-priority capability completed:** Connected `analyseStereoPcm` directly to the `POST /api/waveyard/projects/[id]/mashup` route workflow. When either selected track lacks formal BPM or musical key analysis, raw decoded audio PCM is analysed on the fly using native autocorrelation and spectral/chroma DSP to populate the source profile before planning, rendering, or persisting. The resulting analysis is persisted to the `sourceAnalyses` table using canonical desktop provenance (`arena-js-dsp` v1.4.0) to prevent redundant re-analysis.
* **Stem run reconciliation & save safety:** Updated `action === "save"` to use `findBedSource(projectId, bedId)`, guaranteeing that only stems from the latest completed separation run (or single instrumental stem) are saved into `remixTracks`, matching the render path. Added validation ensuring vocal separation jobs are complete (`status === 'complete'`) and requiring both vocal and bed stems before saving to avoid single-stem incomplete remix sessions.
* **Vocal tempo adoption:** When bed BPM is unanalyzed but vocal BPM is verified, `planMashup` now adopts the vocal BPM as the master tempo rather than falling back to an unverified duration guess.
* **Checksum & provenance validation:** Updated `loadSourceProfile` in `lib/arena/src/lib/waveyard/studio/mashup-sources.ts` to verify source checksum matches `sourceChecksumSha256` and `status === 'complete'`, preventing consumption of stale or unverified analyses.
* **Intelligent multi-stem arrangement:** Enhanced `renderMashup` and route rendering so discrete stems receive structured timeline placements with role-aware dynamic gains without duplicating bed audio.
* **Genuine database round-trip acceptance:** Created and passed `lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts` running against PGlite with canonical desktop migrations. Verified the full lifecycle: creating project, source assets, and stem assets; executing the mashup save transaction into `remixSessions`, `remixTracks`, and `remixClips`; querying and verifying tracks and clips from the database; and updating track volume, clip gain, and master volume with proper session version incrementation.
* **Real-audio & 4-pair acceptance:** Passed `mashup-full-length.test.ts` (4 distinct song pairings testing tempo divergence [85 vs 135 BPM], on-the-fly PCM analysis of unanalyzed audio, harmonic clash adaptation, and full-length multi-stem export with WAV encoding/decoding and lossless plan reopening). Passed all 15 unit tests in `mashup.test.ts`.
* **Automatic musical analysis reliability:** Enforced `trustedAnalysisKey` and `trustedAnalysisBpm` in mashup planning; low-confidence keys withhold automatic pitch shifting (0 semitones); removed fabricated confidence in section-derived fallback estimates; integrated beat grid end-to-end; failed closed in `latestStem` when separation job rows are missing; and strengthened multi-window tempo testing.
* **Files changed:** `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.ts`, `lib/arena/src/lib/waveyard/studio/mashup-sources.ts`, `lib/arena/src/lib/waveyard/studio/mashup.ts`, `lib/arena/src/lib/waveyard/studio/analysis-reliability.test.ts`, `lib/arena/src/lib/waveyard/studio/mashup-db-acceptance.test.ts`, and this handoff.
* **Verification:** Passed all 148 test cases cleanly across Waveyard studio test suites (`analysis-reliability.test.ts`, `mashup-db-acceptance.test.ts`, `mashup-full-length.test.ts`, `mashup.test.ts`, `mashup-regression.test.ts`, `mashup-bed.test.ts`); full workspace `pnpm run typecheck` passed cleanly across libraries, API server, ArenaForge, mockup sandbox, and scripts with zero errors; `git diff --check` cleanly passed.
* **Exact Git revision:** Pending commit of verified hardening fixes.
* **Remaining limitation:** Subjective musical quality of arbitrary song mashups depends on source stem separation quality and listening evaluation; fallback decisions preserve provenance and explain all assumptions.

## Current verification update — 2026-11-10, fallback renderability checks

* **Highest-priority follow-up:** corrected the automatic-remix fallback assertions to follow the actual persisted track ordering and to verify instrumental fallback removes vocals. The fallback remains conservative: both complete sources are represented, source windows alternate across the full timeline, and no untrusted tempo/key/beat transforms are enabled.
* **Files changed:** `lib/arena/src/lib/waveyard/types/__tests__/automatic-remix.test.ts` and this handoff.
* **Verification:** the focused `tsx --test` run passed 23/23 across automatic-remix and render-helper tests; `pnpm run typecheck:libs` passed; `git diff --check` passed.
* **Remaining limitation:** real-song analysis → render → WAV export → save/reopen evidence is still pending; this validates plan/render-helper compatibility, not subjective audio quality.
* **Exact Git revision:** `6cadad5d76e7c12408bccd7975fcfccb6cdb8209`.

Living document for every human or AI agent working on Arena. **Update it in
the same PR as any change that alters status, priorities or the ledger.**
Last updated: 2026-11-10.

## Current verification update — 2026-11-10, fallback reachability fix

* **Highest-priority fix:** removed the stale `hybrid_evidence_unavailable` early return that made the conservative full-song fallback unreachable whenever the anchor lacked trusted structure. Instrumental mode now removes vocals correctly from source-qualified fallback track IDs.
* **Files changed:** `lib/arena/src/lib/waveyard/types/automatic-remix.ts` and this handoff.
* **Verification:** repository `pnpm run typecheck` passes across libraries, API server, ArenaForge, mockup sandbox, and scripts. `git diff --check` is required before commit. The focused automatic-remix test remains blocked because this checkout does not provide `tsx`.
* **Remaining limitation:** real-song render/export/save-reopen evidence is still pending; this fix makes the existing fallback reachable but does not add a second renderer or claim musical quality.
* **Exact Git revision:** `4a6ad6697e3de6e6761a1da653a470b9a2c47d31`.

## Current verification update — 2026-11-10, full-song fallback vertical slice

* **Implementation completed:** `buildAutomaticRemixPlan` no longer rejects a requested hybrid solely because passage evidence is missing or no pair clears the existing confidence gates. It preserves those gates and falls back to the existing persisted `AutomaticRemixPlan`/`RemixClip` shape: every usable stem from both complete sources is arranged as alternating first-half/second-half passages across a continuous timeline. The fallback makes no unverified BPM, key, or beat-snap claim, uses conservative gain and short fades, and records notices/decisions explaining the evidence boundary.
* **Files changed:** `lib/arena/src/lib/waveyard/types/automatic-remix.ts` and `lib/arena/src/lib/waveyard/types/__tests__/automatic-remix.test.ts`. This is intentionally inside the existing arranger; no second renderer, persistence model, or UI engine was introduced.
* **Test evidence:** Added coverage proving a difficult pair with generic/unavailable section evidence produces eight stem tracks, two clips per source track, alternating timeline ownership, and conservative beat/key flags. Existing compatible, low-confidence, provenance, semantic-label, and empty-source cases remain covered. The focused test could not execute in this checkout because `tsx` is not installed; `pnpm run typecheck` passes for libraries, API server, ArenaForge, mockup sandbox, and scripts; `git diff --check` passes.
* **Real-song evidence:** No real-song render was run in this task because the checked-out acceptance recordings are not present in the repository and the focused test runner dependency is unavailable. The new fallback is designed to accept those difficult pairs, but continuous audio quality, WAV export, and save/reopen still require the existing real-stem acceptance harness to be run with the supplied recordings.
* **Remaining limitations:** This slice is an arrangement decision, not a new DSP renderer. It does not yet time-stretch, pitch-shift, isolate stems, or synthesize beat/bar transitions for the fallback; it deliberately preserves source timing and provenance. The existing rendering/export path must consume the generated clips, and real separated-stem acceptance remains required before claiming listening quality.
* **Exact Git revision:** `00214f08712e1a912f6cb988626e86fc6df27ce0`.

## Current verification update — 2026-11-10, Waveyard cross-song passage compatibility

* **Preserved checkout:** still on `arena/convergence-2026-11-07` at
  `52a0ba903854234a135e583814cb7ba1be73d3e7`, five commits ahead of
  `origin/arena/convergence-2026-11-07`. This work is local and uncommitted;
  no commits, pushes, merges, branch switches or history edits were made. The
  user-provided audio remains untracked and is not part of the change.
* **Persisted evidence:** source-section engine provenance is now 1.5.0.
  Each source section can retain a checksum- and beat-range-bound passage
  fingerprint: a four-subdivision-per-beat onset pattern (length varies with
  the phrase), four-window/12-pitch-class chroma
  sequence, four-subdivision beat-phase profile and source RMS energy. The
  record also has explicit `measured` / `unavailable` slots for downbeat
  confidence, vocal activity and non-vocal instrument density. The section
  worker currently measures the first four from source PCM; current isolated
  vocal phrase coverage is attached by the automatic-remix route when matching
  stem/source provenance exists. No downbeat or non-vocal activity detector is
  claimed. Fingerprints are persisted in nullable `source_sections` JSONB;
  additive desktop migration `0025_source_section_passage_fingerprints.sql`
  and a PGlite persist/reload test cover the schema. The development schema
  push completed; production was not changed.
* **Compatibility and product path:** automatic hybrid planning now evaluates
  tempo and confidence, exact measured phrase length, onset rhythm, chroma,
  beat phase and allowed transposition independently. It no longer hides
  rejected donors behind an early tempo-ratio filter. Rhythm cannot substitute
  for harmony; a shifted chroma match is permitted only when both trusted key
  analyses authorize that shift. Passage matches do not need verse/chorus
  labels. Reports retain source names, passage IDs, per-dimension explanations
  and missing evidence. The existing route still creates ordinary persisted
  RemixTrack/RemixClip sessions only for eligible candidates. The Studio shows
  compatibility evidence expanded by default, including on a no-match error;
  it explicitly calls a match an audition candidate rather than a quality
  claim.
* **Real-audio acceptance:** the six user-provided recordings were each analyzed
  in full (215–406 seconds), producing 246 section fingerprints and 24,941
  cross-track passage comparisons. **Zero** pairs passed every core gate, so no
  hybrid arrangement or render was generated and none was listened to. Examples
  of correctly rejected pairs: a Queen / “Blinding Lights” two-bar pair had
  tempo ratio 0.638, rhythm similarity 0.818, chroma 0.811 and beat-phase
  similarity 0.992; “I Feel It Coming” / “Blinding Lights” had ratio 0.909,
  rhythm 0.794, chroma 0.803 and phase 0.987. Another Queen / “Blinding
  Lights” window had chroma 0.939 only after a one-semitone shift, but the
  key estimates did not authorize it, and tempo/rhythm also conflicted. A
  matching beat-phase profile by itself did not produce a match. The scan found
  missing isolated-vocal activity, non-vocal stem activity and downbeat
  confidence across these source-only files.
* **Repeatable real-audio check:** run
  `WAVEYARD_ACCEPTANCE_TRACKS="<six full paths separated by the OS path delimiter>" node --test scripts/waveyard-cross-track-acceptance.test.mjs`.
  It calls the existing full-track analyzer, requires six tracks with
  fingerprints and at least 180 seconds each, and asserts no false compatible
  pair for this six-track acceptance set. This run passed 1/1 in 82.1 seconds.
  It is an opt-in local acceptance, not a CI fixture: the supplied tracks are
  not copied into or committed to the repository. Synthetic positive/negative
  unit fixtures separately cover compatibility logic. The pinned input
  checksums were verified, and the acceptance run passed 1/1 in about 79
  seconds.
* **Verification:** focused Waveyard tests passed 40/40, including provenance,
  rejection cases, tempo conflict visibility and PGlite persistence. Library,
  API-server, ArenaForge and scripts TypeScript checks passed; `git diff
  --check` passed. The configured broad `test` workflow is **not green**: its
  Arena smoke step failed on browser error `Cannot close a closed AudioContext`
  after the preceding Waveyard browser-audio checks passed. This work did not
  change the playback context lifecycle. A Waveyard landing-page screenshot
  loaded without browser errors, but it had no song/remix open, so it does not
  verify the interactive evidence panel.
* **Remaining gap / next evidence needed:** the current engine can compare
  measured source passages but this dataset supplies no compatible pair. To
  produce reliable vocal-over-instrumental candidates, add and validate a
  downbeat detector plus per-passage isolated-vocal and non-vocal-stem
  activity; retain source/stem checksum provenance. Then run a real separated
  stem project through analysis → automatic remix → persisted clips → export →
  save/reopen, and listen to any candidate before making quality claims.
  This implementation does not establish musical form, reliable smart-mashup
  quality, a successful real-stem hybrid, or listening quality.

## Current verification update — 2026-11-10, Waveyard full-track analysis and PR #29

* **Branch and preserved history:** work remains on
  `arena/convergence-2026-11-07`. The preserved local commits
  `0b11894`, `a25af3a`, and `be50cc1` remain ahead of PR #29's remote head
  `8083fd88`; the Waveyard implementation is committed locally as `be262941`.
  The PR is still open against `main`; none of these newer local commits has
  been pushed or merged. GitHub check results documented below apply to the
  remote PR head, not the local Waveyard work.
* **Remote CI boundary:** the four successful Windows package, recovered-stack,
  browser-timing and Linux worker-local DB runs listed below are evidence for
  their exact recorded SHAs only. The recovered-stack inference probe uses a
  controlled Demucs stand-in, not a trained model. No new CI run is claimed for
  `be262941`.
* **Real mixer acceptance already completed:** two user-provided MP3s (Earth,
  Wind & Fire “September” and Queen “Another One Bites the Dust”) were imported
  as 48 kHz stereo and completed all four pinned CPU separation passes. The
  corrected Linux acceptance persisted four stems per 30.024-second excerpt,
  verified unchanged source checksums, loaded real stems through private
  routes, crossfaded between tracks, isolated incoming drums while playback
  continued, then restored all four gains. It passed 1/1 in about 273 seconds.
  This proves the persisted playback and control path for short excerpts, not
  subjective stem quality or a good mashup.
* **Implemented musical-analysis slice:** the local section engine now searches
  beat-grid-aligned 2-, 4- and 8-bar windows independently of variable
  novelty-boundary lengths. It uses half-window hops, prefers longer
  non-overlapping matches, keeps the existing 0.92 similarity threshold, and
  requires both rhythm and four-bin chroma similarity for a “pattern” label.
  Otherwise it reports a rhythm-only recurrence. The engine provenance is
  `arena-js-structure` 1.4.0. Repeated labels are exposed as measured
  similarity in the Studio label text, not presented as calibrated
  probabilities. One-past-last beat boundaries now normalize using the median
  beat interval and clamp to known source duration, so final sections can be
  validated and persisted without extending beyond the file.
* **Full-track evidence:** the reproducible `scripts/waveyard-mashup-analysis.ts
  -- <output.json> 0 full <audio paths...>` run analyzed six user-provided
  tracks, each for its complete 215–406 seconds. The evaluator passed the same
  section normalization/provenance validator used by the worker for all six.
  It found 41 rhythm-only windows and 10 combined rhythm+chroma windows; those
  combined windows occurred in two tracks. Four windows were four bars long;
  none reached eight bars. The previous zero-result scan compared
  novelty-segment candidates with varying lengths; fixed phrase windows
  exposed recurrences hidden inside those segments without lowering thresholds.
* **What this does not prove:** “pattern” means a repeated beat-grid onset and
  coarse chroma fingerprint, not a verified chord progression, downbeat,
  verse, chorus, or cross-song match. The analyzer still has no vocal-activity
  feature or manually annotated reference sections. On this full-track
  six-source set, only one track passed the existing 0.5 BPM/key/beat
  confidence gates, so there is no eligible donor pair to demonstrate a real
  hybrid. No mashup render was listened to or rated. The automatic hybrid
  arranger still requires explicit high-confidence semantic roles; its passing
  synthetic-role tests do not establish that real analysis can produce them.
* **Verification:** focused Waveyard section, source-section, provenance and
  automatic-remix tests passed 33/33; `pnpm run typecheck` and `git diff
  --check` passed. The six-track full-audio scan also completed with all section
  records passing persistence-shape validation. That scan is analysis evidence,
  not a database persist/reopen or musical listening acceptance.
* **Next concrete work:** add explainable, persisted passage features for
  cross-source compatibility—harmonic movement, vocal/instrument activity and
  beat/downbeat phase—then use them in the existing RemixTrack/RemixClip
  arranger. Validate against manually annotated sections and listen to actual
  candidate renders. Keep confidence gates unchanged until the measurements
  justify any adjustment.

## Current verification update — 2026-11-10, Windows readiness at `dd2d2862`

This section supersedes older Windows/AI acceptance claims below. Green CI is
not equivalent to owner-side release acceptance.

* **Branch preservation:** the starting workspace was clean on
  `arena/convergence-2026-11-07` at `7c2df817`. Its remote branch and PR #29
  had advanced linearly to `ef042aea`; the supplied branch
  `arena/caafeea9-arena-os-canonical` was a further linear descendant at
  `dd2d2862`, with no PR of its own. The three commits `3f064578`,
  `d1948f0f`, and `dd2d2862` were fast-forwarded onto the existing convergence
  branch. No branch was deleted, no history rewritten, and PR #29 was not
  merged. The handoff-only change in this PR does not alter the tested code.
* **What happened at `ef042aea`:** that commit changed only `docs/HANDOFF.md`
  and `docs/LINUX-TEST-COVERAGE-2026-11-09.md`. Nevertheless, the recovered-stack
  workflow did execute (run
  [42673833952](https://github.com/imlochie/arena-os-canonical/actions/runs/42673833952))
  and failed: `python-guardian.test.ts`'s first test exceeded its unchanged
  10-second budget, and the inference-probe test skipped because Windows had no
  FFmpeg/FFprobe. This was an executed failing run, not a rerun refusal.
* **FFmpeg and test reporting fix:** `3f064578` stages the exact SHA-256-pinned
  FFmpeg bundle used by the installer, executes both `ffmpeg.exe` and
  `ffprobe.exe`, and sets `ARENA_FFMPEG_PATH` / `ARENA_FFPROBE_PATH`. A skipped
  or missing probe is now an error. Failed-file TAP output is included in
  bounded check annotations. The same commit improves browser timing failure
  annotations; it does not alter the app's audio engine.
* **Python guardian regression:** `d1948f0f` discovers the test interpreter once
  before the individual test clocks begin. The two tests retain their 10-second
  timeouts and the 1.5-second owned-process termination bound; the assertions
  were not relaxed. Windows run
  [42681735032](https://github.com/imlochie/arena-os-canonical/actions/runs/42681735032)
  passed. Its runner was Python 3.15.2: spawn-to-close was 273 ms; the
  termination test reported 73 ms to start, 3 ms for executor close, and 3 ms
  until the owned Python process was gone. These are one CI-runner's timings,
  not laptop performance guarantees.
* **Windows package evidence:** run
  [42681734757](https://github.com/imlochie/arena-os-canonical/actions/runs/42681734757)
  passed on `dd2d2862`. It built the x64 NSIS installer, installed
  `ArenaForge.exe`, passed the installed-package smoke, then passed the
  previous-to-current package update smoke. The `arenaforge-windows-x64`
  artifact was uploaded (390,749,118 bytes; 14-day retention at run time).
  This proves hosted Windows CI packaging/install/update behavior, not
  installation on the owner's laptop.
* **Local regression checks after integration:** the focused
  `python-guardian.test.ts` run passed 2/2 with no skips, and `pnpm run
  typecheck` passed.
* **Inference-probe limit:** the passing CI probe used the real staged FFmpeg
  binaries to process six controlled WAV inputs, but its Demucs runner is a
  controlled stand-in and no trained checkpoint was present. The log explicitly
  says real Demucs inference is **not** proven. No real provider/model inference
  was performed; do not mark the AI-runtime gate PASS.
* **Owner-side Windows acceptance checklist (not yet performed):**
  1. Open the Windows package run above and download its
     `arenaforge-windows-x64` artifact. Extract the ZIP and run the non-
     uninstaller `.exe`; use the install directory selected in the installer.
     Launch `ArenaForge.exe` from that directory.
  2. Open **Model Hub** in the installed app and confirm its host notice says
     Arena is running on **this device**. Do not use the Replit preview for a
     laptop-local model: that preview checks Replit's server.
  3. To avoid cloud fees and quotas, install and open Ollama on this same PC.
     In Model Hub, select **Refresh runtime status**, **Connect runtime** for
     the discovered Ollama service, then **+ Add [model] to Arena** for an
     installed model. Choose a catalog model only after checking its displayed
     download size and approximate RAM class against the laptop.
  4. In **Spaces**, select that registered model and run a new disposable task:
     use `write_file` to create `acceptance-check.txt` with a unique
     owner-chosen token, then use `read_file` to return its exact contents.
     Reopen the Space and verify the file is still present.
  5. Count this as genuine inference/tool acceptance only if the journal shows
     the real runtime level, provider and actual model ID, **no `FALLBACK`**,
     a successful tool action and the expected file contents. A model being
     listed or a health check passing is insufficient. Return a screenshot of
     that result and the package-smoke report; do not include API keys or other
     secrets.
* **Waveyard real-audio status:** the full-track scan of six user-provided
  tracks found zero qualifying repeated rhythm/harmony patterns and no manual
  verse/chorus reference labels; it does not establish musical-form understanding.
  A real 20-second September excerpt did pass the pinned four-model separation
  and persisted four stems on Linux, but audio quality was not evaluated. The
  later report of a second-track stem-ID mismatch was a test false positive:
  standby sources are `blob:` URLs, not asset IDs. The latest two-track browser
  trials persisted the expected stems but did not reach a passing crossfade
  and incoming-isolation acceptance. See the current verification update
  above. MIDI/export/save/reopen as one real-audio workflow and owner-device
  listening remain unverified.

## Current verification update — 2026-11-09, cold-start acceptance at `32cf4a54`

This section supersedes older status claims below where they conflict.

* **Deep checkpoint identity, applied consistently (2026-11-09):** the deep
  separation path verifies the pinned Demucs checkpoint's full SHA-256 before
  any inference (`verifyDeepCheckpoint`, injectable through `deps`). Two handler
  tests already used the explicit stand-in checkpoint; the deep-cancellation
  process-group test still called the real verifier with the fixture's
  presence-only dummy checkpoint, so it failed *before* spawning the stub engine
  and reported "the Demucs process started" instead of testing cancellation.
  It now uses the same stand-in override as its siblings; checkpoint identity
  remains covered by `separation/deep.test.ts`. Local evidence on this branch
  (Linux, real embedded PostgreSQL, real Python 3.11 stub engine, ffmpeg from
  the installer packages): `worker-local/separation.test.ts` 54/54 pass,
  including process-group cancellation and clean retry; the library service
  suite 53 pass with its 4 opt-in real-worker/browser tests skipped by default;
  the other branch-changed Waveyard suites 194/194 pass; `pnpm run typecheck`
  passes. This is **not** evidence of real Demucs inference or weights, the
  browser retry/donor acceptance runs (no Chromium or pinned model files in
  this environment), or packaged Windows. The CI gap this exposed (no workflow
  ran this suite; `windows-recovered-stack.yml` omits it and its cancellation
  case skips on win32) is closed by the Linux job in the next bullet.
* **Linux CI for the DB-backed Waveyard worker-local suites (2026-11-09):**
  `.github/workflows/waveyard-worker-local-db.yml`, job `worker-local-db` on
  `ubuntu-22.04` (push, pull_request, workflow_dispatch; 30-minute cap). It
  installs `@workspace/scripts... @workspace/arena... @workspace/desktop...`
  (desktop is required: `separation.test.ts` migrates its disposable cluster
  through the production migrator `desktop/database.mjs`, which imports `pg`
  from `desktop/node_modules`), puts the runner image's PostgreSQL server
  binaries on PATH, boots a throwaway cluster the way the suite does (initdb
  as the runner user, TCP on 127.0.0.1, no Unix socket) and fails loudly if
  that, ffmpeg/ffprobe or Python 3 is missing, then runs
  `worker-local/separation.test.ts`, `stem-analysis.test.ts` and
  `analysis-recovery.test.ts` one file at a time with per-file TAP evidence
  (artifact `worker-local-linux-<run>-<attempt>`, 14 days). The
  deep-cancellation process-group test is a hard gate: the job greps for its
  passing TAP line and a skip or missing line fails the job; other skips are
  surfaced as warnings, never counted as passes. Failing TAP results are
  annotated with their diagnostic block because job logs and artifacts were
  not readable from the authoring sandbox. **Evidence:** first green run
  <https://github.com/imlochie/arena-os-canonical/actions/runs/42650096758>
  (push of `8d8e319` on `arena/convergence-2026-11-07`, 3m14s): all three
  files PASS, zero skips, no error annotations; environment notice reports
  PostgreSQL 14.24 (`14.24-1.pgdg22.04+2`), ffmpeg 4.4.2, Python 3.10.12.
  The three earlier runs on this branch (`f5cf74d`, `7d73635`, `9d16d12`)
  failed only separation tests 5/15/16, the ones that start a real cluster,
  with "Cannot find package 'pg' imported from desktop/database.mjs"; adding
  the desktop filter fixed it, and the fix was first reproduced locally after
  deleting every `node_modules` directory (an earlier clean-room check had
  missed `desktop/node_modules`). Local clean-room run of the workflow's test
  step with embedded PostgreSQL 14.24: 54/54, 1/1, 2/2, zero skips.
  **Limitations:** the job uses the runner's PGDG PostgreSQL 14, not the
  embedded 16.14 build the desktop ships (the 25 desktop migrations use no
  15+-only syntax, and the suite passes on both); the deep pass is the stub
  engine driven by real Python, with no pinned Demucs/ONNX weights, no GPU and
  no real inference; `separation-real-ort.test.ts` is deliberately excluded
  (it skips without pinned weights); the job cannot run on the Windows runner
  (no PostgreSQL server binaries there, and the cancellation case skips on
  win32), so Windows coverage of this suite is still not claimed. The only
  remaining annotation on the green run is GitHub's generic "Node.js 20 is
  deprecated" notice about the `@v4` actions, shared by every workflow here.
* **Linux test coverage map (2026-11-09, measured; supersedes the "76
  environment-dependent failures" figure):** every one of the 285 test files
  was run on provisioned Linux (PostgreSQL server binaries, ffmpeg, Python 3,
  `DATABASE_URL` unit convention, package cwd): **2,152 tests, 2,078 pass, 51
  fail, 23 skip, 22 failing files**; with a live PostgreSQL on 5432 and the
  migrations applied, 2,102 pass / 34 fail / 16 skip / 16 failing files. CI
  today runs 53 of the 285 files automatically (24 Windows recovered-stack,
  26 desktop on Windows, 3 on Linux); **232 files run nowhere, 212 of them
  pass on Linux today** (1,658 passing tests). Every failing file is
  attributed by class (browser 5, live-postgres 6, network 2, built
  artifacts 2, stale/vite-only/browser-globals/fixture 6, cwd 1) in
  `docs/LINUX-TEST-COVERAGE-2026-11-09.md`, with the per-file appendix and the
  reproducible method. Four files only pass from their package directory
  (`authorization.integration`, `deviceChannel.integration`, `wave3`,
  `arenaRooms`), so a Linux job must not run everything from `scripts/`.
  **Chosen next step (one credit):** a Linux sweep job over `lib/`,
  `artifacts/`, `scripts/` test files minus the 3 the DB job runs and an
  explicit, reasoned exclusion list — measured today at 235 files / 1,838
  passing tests / 16 opt-in skips, ~9 minutes of summed per-file time. Not
  chosen yet, with numbers in the doc: a live PostgreSQL service (+24 tests),
  Playwright browsers (+21 tests, 5 files), and the small test fixes (stale
  `broker` queue list, two dead-path tests, four cwd-relative paths).
* **Arcade CSP policy map (2026-11-09, investigation only; nothing changed):**
  plan B.2 ("wire `sandboxGameDocument` into the player") predates the player
  having its own policy, and the two are not interchangeable. There are four
  hand-maintained policies, not two:
  1. **Player** — `artifacts/arenaforge/src/lib/arcadeGameSave.ts:74`
     (`createGameSandboxDocument`): `script-src`/`style-src 'unsafe-inline'
     data: blob:`, `font-src data: blob:`, `img/media-src data: blob:`,
     `connect-src/frame-src/object-src/form-action 'none'`, `base-uri 'none'`;
     no `worker-src`, so blob/data workers fall back to `script-src` and are
     allowed. It injects the policy *and the save runtime* into the game's
     existing `<head>`. Used by `ArcadeForge.tsx:2171`, the local-model check
     at `ArcadeForge.tsx:1857` and `ImportedGameWorkspace.tsx:1351`, all with
     `sandbox="allow-scripts"`; only the imported-game frame sets
     `referrerPolicy="no-referrer"`.
  2. **Arcade runtime gate** — `artifacts/api-server/src/imported/arcade/runtime-verification.ts:33`:
     the *same string as the player*, copied, plus a probe; the verification
     page itself is served with `frame-src 'self'` and every http(s)/ws request
     is aborted and counted (`blockedRequests`).
  3. **2048 source-rule gate** — `lib/arena/src/lib/games/sandbox.ts`
     (`GAME_CSP`: no data:/blob: scripts or styles, `font-src 'none'`,
     `worker-src 'none'`, referrer meta) used by `source-rule-validation.ts`
     and for the `preview` document that `ArcadeSourceWorkshop.tsx:83` renders
     verbatim, under `ARCADE_HOST_CSP` (`frame-src 'none'`). Its header says
     "same CSP as Arcade validation"; that is no longer true (see 2).
  4. **Foundry** — `lib/arena/src/lib/foundry.ts:44` (`injectCsp`): `font-src
     data:` only, no connect/frame/form-action directives, and it *skips
     injection when the code already carries a CSP meta*; rendered by
     `app/foundry/page.tsx:257` with `allow-scripts allow-forms allow-modals`.
     Outside the Arcade scope; noted because the opt-out is a real gap.
  **Why the player is looser than `GAME_CSP`, and why that is required:**
  `games/imported-html.ts:17-19` deliberately admits `data:`/`blob:` in
  `src`/`href`/`url()`, so base64 scripts, fonts, images and blob workers are
  part of the accepted single-file game contract; the runtime gate uses the
  same string so that what is verified is what runs. `GAME_CSP` is right for
  the 2048 gate, which verifies a pinned fragment it wraps itself. The
  player's extras are all non-network sources: with an opaque origin
  (`allow-scripts` only), `connect-src 'none'`, `frame-src 'none'`,
  `object-src 'none'` and `form-action 'none'`, and workers inheriting the
  owner document's policy, they add no exfiltration path. So unifying on
  `GAME_CSP` would break accepted games for no isolation gain, and unifying on
  the player policy is only a *copy* problem, not a policy problem.
  **Safe without a decision (not done yet):** export the player policy once
  (next to `GAME_CSP` in `games/sandbox.ts`; `@workspace/arenaforge` and
  `@workspace/api-server` both already depend on `@workspace/arena`), import
  it in `arcadeGameSave.ts` and `runtime-verification.ts`, add the test plan
  B.1 asked for (policy precedes untrusted markup; gate and player documents
  embed the identical policy), and fix the stale header comment in
  `source-rule-validation.ts`. Zero behaviour change.
  **Needs a design decision (stopped here):** both gates run the game under a
  *host* CSP that stops the sandboxed frame from navigating itself to a
  network URL, which is the one channel the inner policy cannot close; the
  production pages have no host CSP at all (none in `artifacts/`, `desktop/`
  or `lib/` outside the gates), so a game that passes verification can still
  navigate its frame later. A document-level CSP on the app affects every
  embed (e.g. `EmulatorJsPlayer.tsx:124` uses `allow-same-origin`) and the
  Vite, api-server static and Electron delivery paths, so it is a product
  decision, not a cleanup. Adding `referrerPolicy="no-referrer"` to the two
  Arcade frames that lack it belongs to the same decision.
* **Waveyard local analyses:** the desktop API selects the versioned local
  engine and starts the existing drum, harmony, and vocal queues. Their DSP
  handlers persist events/frames with checksums and engine provenance; API
  startup replays interrupted durable jobs. Generated WAV + PGlite +
  filesystem-backed tests: 25/25 pass, including failure, retry, stale
  provenance, and restart recovery. This is generated-audio evidence, not a
  real-song run.
* **Queued MIDI export:** the local exporter rechecks the immutable job's
  source/stem/analysis identity, validates a Standard MIDI round trip, and
  persists a checksummed MIDI export asset. It does not fabricate drum classes
  or weak harmony notes.
* **Waveyard reliability suites:** 169/169 tests pass across the original full
  live-stem-layer regression suite, session-save journal replay/acknowledgment,
  MIDI writer/reader, player state, normalization, and source-section data.
  Full workspace typecheck passes. Pre-existing normalization source/tests
  remain uncommitted user work.
* **Browser timing:** push run `42598958628` and PR run `42598965343` passed
  Chromium, Firefox, and WebKit in the Linux PulseAudio harness. The earlier
  WebKit timing failures were test fixture/session lifecycle races; the harness
  now isolates session state and loops the normal-sized timing fixture. This is
  timing acceptance, not hardware listening or the full browser app matrix.
* **Windows packaged acceptance:** push run `42598958551` and PR run
  `42598965368` both passed. Each built the current x64 installer, installed
  and launched it, exercised the packaged app/database/migrations, navigated to
  Waveyard and played generated test audio, checked encrypted backup/restore
  including tamper rejection, then installed the current package over the
  older package and verified a saved record survived restart.
* **Cold-start source fallback:** forced workflow-dispatch run `42600674680`
  passed end to end with `force_source_baseline=true`, which skips accepted
  installer lookup. It first built the current installer from scratch, then
  built the previous app from source using validated SDL/FFmpeg inputs from
  that build. The prior app's independent emulator downloads are not installer
  payload and are skipped in this update-only build. The temporary worktree now
  carries repository metadata for electron-builder and uses a short
  long-path-safe location. The installed-app and in-place update smoke passed.
  No pinned release CDN 504 occurred in this forced source run.
* **Recovered-stack Windows tests:** push run `42598958617` and PR run
  `42598965365` passed.
* **Real-song section evaluation:** the local DSP analyzed the first 65 seconds
  of six user-supplied MP3/M4A tracks. BPM / BPM-confidence and key /
  key-confidence were: Another One Bites the Dust 109.957 / 0.512, F minor /
  0.034; September 123.047 / 0.624, A major / 0.573; I Feel It Coming remix
  156.605 / 0.323, D# major / 0.086; Stayin' Alive remix 103.359 / 0.380,
  F minor / 0.472; I Want to Break Free remix 72.788 / 0.913, C# minor /
  0.584; Blinding Lights remix 172.266 / 0.878, C minor / 0.245. Only
  September and I Want to Break Free pass both current tempo and key gates.
* Section notation below is `bar-range start–end label (L/S)`: `L` is the
  stored label evidence value and `S` is the existing onset-boundary structural
  confidence. For energy labels only, `L = min(1, |RMS dB change| / 6)`; it is
  a normalized signal-change strength, **not** a calibrated probability.
  `section L0` means a detected boundary with no stronger label evidence.
  Energy deltas compare a section's RMS with the immediately preceding section.
  No manual verse/chorus ground truth was available; no semantic roles were
  assigned.
  * Another One Bites the Dust: `b1–4 0:00–0:08 section (0/.050)`; `b5–6
    0:08–0:13 energy-rise (.811/.521, +4.9 dB)`; `b7–13 0:13–0:28 section
    (0/.489)`; `b14–18 0:28–0:39 section (0/.514)`; `b19–22 0:39–0:48
    section (0/.455)`; `b23–24 0:48–0:52 section (0/.961)`; `b25–29
    0:52–1:03 section (0/.850)`.
  * September: `b1–4 0:00–0:07 section (0/.150)`; `b5–7 0:07–0:13
    energy-rise (1/.781, +9.4 dB)`; `b8–19 0:13–0:37 energy-rise (.763/.854,
    +4.6 dB)`; `b20–22 0:37–0:42 section (0/.635)`; `b23–32 0:42–1:02
    section (0/1.000)`; `b33–33 1:02–1:04 section (0/1.000)`.
  * I Feel It Coming remix: `b1–2 0:00–0:03 section (0/.846)`; `b3–6
    0:03–0:09 energy-rise (1/.960, +15.4 dB)`; `b7–8 0:09–0:12 section
    (0/.627)`; `b9–16 0:12–0:24 section (0/.444)`; `b17–19 0:24–0:29
    energy-rise (1/.407, +7.3 dB)`; `b20–21 0:29–0:32 section (0/.495)`;
    `b22–23 0:32–0:35 section (0/.452)`; `b24–27 0:35–0:41 section
    (0/.436)`; `b28–29 0:41–0:44 section (0/.484)`; `b30–32 0:44–0:49
    section (0/.416)`; `b33–38 0:49–0:58 section (0/.988)`; `b39–40
    0:58–1:01 section (0/.418)`; `b41–42 1:01–1:04 section (0/.474)`.
  * Stayin' Alive remix: `b1–3 0:00–0:07 section (0/.482)`; `b4–5
    0:07–0:12 section (0/.682)`; `b6–12 0:12–0:28 section (0/.574)`;
    `b13–22 0:28–0:51 energy-rise (1/.586, +9.1 dB)`; `b23–28 0:51–1:05
    section (0/.918)`.
  * I Want to Break Free remix: `b1–12 0:00–0:39 section (0/.269)`; `b13–17
    0:39–0:56 section (0/.973)`; `b18–19 0:56–1:02 section (0/.482)`.
  * Blinding Lights remix: `b1–8 0:00–0:11 section (0/.638)`; `b9–12
    0:11–0:16 energy-rise (1/.475, +8.0 dB)`; `b13–17 0:16–0:23 energy-rise
    (.574/1.000, +3.4 dB)`; `b18–19 0:23–0:26 section (0/.671)`; `b20–29
    0:26–0:40 section (0/.514)`; `b30–34 0:40–0:47 section (0/1.000)`;
    `b35–45 0:47–1:02 section (0/.506)`; `b46–46 1:02–1:04 section
    (0/.603)`.
* **What the detector now establishes:** sustained RMS changes marked eight
  dynamic rises on five tracks; the comparatively level Queen excerpt received
  none. The combined rhythm-plus-four-bin-harmony repeat test found no
  qualifying repeated patterns in these excerpts. That is an honest abstention,
  not proof that the full songs lack repeated structures. `energy-rise` is a
  dynamic cue only, never a chorus/verse label or cross-track matching signal.
  Automatic hybrid alignment still accepts only supported semantic roles.
* The section inspector now distinguishes detected boundaries, rhythm repeats,
  combined audio-pattern repeats, and measured energy changes. Compact player,
  visual, and mashup-source labels continue to show weak key/tempo values as
  uncertain; Studio alignment withholds low-confidence tempo/key/beat grids.
  Focused structure, confidence, source-label and remix tests: 29/29 pass; full
  workspace typecheck passes.
* This local analysis does not prove manually verified role recognition,
  persisted analysis of these six tracks, four-stem separation, an audible
  mashup, MIDI export/save/reopen as one user flow, provider inference, or
  hardware listening.
* **Branch preservation:** this branch is still `arena/convergence-2026-11-07`.
  Its previous confidence-UI changes now exist in local commit `22d7fd5`
  (parent `fe1af426`), one commit ahead of the remote; this task's section
  changes remain uncommitted. No push or PR merge occurred. The `replit-agent`
  ref remains at `a5bc2a96`; its recent rhythm-analysis and automatic-remix
  work has equivalents here (`4430b555`, `84bbc553`). Its tip tree equals
  merge-base `b54840f2`, so no net tree change from that ref needed wholesale
  porting.
## Status at `3a782f73` (2026-11-08) — supersedes any conflicting text below

Read this section first; older sections are kept for history and are marked
where they are stale.

### What was fixed in this pass
| Area | Finding | Fix (commit) |
|---|---|---|
| Windows package | `embedded-postgres` `package.json` export error is **resolved**; installer builds, installs, packaged smoke passes (11 checks incl. backup/restore, ffmpeg, capture host). | earlier `desktop/build.mjs` fix |
| Windows update | Previous (base) package could not start on the elevated runner: PostgreSQL refuses `postgres.exe` for admins (`older_package_starts`). | `database.mjs` added to the base-fix list (`1ce31981`) |
| Windows update | Intermittent `current_package_starts`: after an in-place update the window stayed on an empty page (url `""`, loading, renderer idle, `/spaces` already answered). Observed on both events, ~50% of runs. | Clear leftover service-worker/cache storage before loading (`96810e3a`). **Hypothesis-driven** — see evidence below |
| Windows update diagnostics | Failures printed nothing. | log dump, window/process state, Chromium log, bounded cleanup (`59a7c4ec`, `d8bc1430`, `320223b3`) |
| Arcade gate | **Already on `main`** (`imported/arcade/runtime-verification.ts`, used by all three publish paths); the "genuinely missing" claim was stale. Added a uniform-canvas check and 11 tests (all 9 built-in games, blank canvas, no animation loop, obfuscated egress, bad browser path, static-invalid code). | `6fb7a456` |
| Content objects | Storage primitives added: `StorageIntegrityError`, `contentObjectKey`, `putImmutableStream` (hash+count while writing, dedup, replace corrupt copy, temp cleanup), `verifyObject`; 10 tests, in the Windows stack workflow. | `bbeefba1` |
| Waveyard Firefox | Play reported "interrupted" on a working device: first `resume()` settled *running* after 1805 ms, past the 1500 ms bound. Bound raised to 6000 ms with a regression test; no test threshold changed. | `3a782f73` |
| Waveyard WebKit | One confirmed restore-control failure: the `d8bc1430` push run resolved the button, then WebKit reported it unstable and detached. Added probes have not captured a recurrence; root cause **open**. | `17420c42`, `0e9ef2b6`, `77aef143` |

### Waveyard convergence follow-up (2026-11-09)

* Local drum, harmony, and vocal analysis execution is now committed on the
  convergence branch (`47ec26ac`, race guard `9a3a3dcb`). The local desktop
  worker runs versioned DSP jobs against local audio, persists normalized
  results with source provenance, and recovers queued jobs after restart. See
  the dedicated test and limitations below.
* At `9a3a3dcb`, the latest Windows x64 installer workflow completed green on
  the PR run (run `42553704812`): previous package install/start, database and
  migration readiness, record preservation across in-place update, clean
  database shutdown, plus the packaged smoke job's backup/restore checks.
  A second push-triggered package job (`42553701167`) also completed green with
  those same assertions. This is repeatability evidence for the existing
  service-worker/cache-clear mitigation, not proof of its
  underlying renderer lifecycle cause. The installed-package smoke exercises
  startup and packaged services; it does not prove audible real-audio playback.
* The same PR head's cross-browser live-stem timing workflow is green in both
  push and PR runs (`42553701083`, `42553704712`), covering Chromium, WebKit,
  and Firefox on the Linux PulseAudio null-sink harness. Historical WebKit
  restore-control flakiness remains unexplained; current green runs do not
  establish the original race's root cause.
* At `32639378`, the packaged Windows smoke now passed in both push and PR
  package runs (`42556175197`, `42556181034`) with a generated real PCM tone:
  Waveyard project creation, normal `/api/uploads` intake, exact byte retrieval
  from the private `/api/assets` route, and renderer playback after a click
  with media time advancing. Existing install, database, backup/restore, and
  in-place update checks also passed. This proves packaged real-audio decode
  and playback plumbing with generated audio, not human listening, real-song
  quality, or local model inference.
* Local syntax, whitespace, and workspace typecheck passed for the smoke change.
  The full desktop unit suite reported 122 pass / 1 fail / 16 skip: the unrelated
  `arcade-classic.test.mjs` symlink fixture fails with Windows `EPERM` in this
  environment; no assertion was weakened. The Windows CI packaging unit step
  passed on both runs.

* Analysis retries now claim the failed durable row before queue hand-off;
  queue refusal restores the original failure only while the row remains
  queued. Both failed-job retry and stale-analysis refresh paths avoid
  overwriting a fast worker's completed result, and queue handles are closed.
  Commits: `77fa1a6e`, `9ee9e0af`.
* Local API restart now requeues pending source BPM/key/beat and structural
  analyses from their durable rows. Queue refusal is guarded so an analysis
  already advanced by a worker is not marked failed. PGlite restart/retry and
  local DSP tests: 18/18 pass; normalization tests: 6/6 pass. Full workspace
  typecheck passes. These do not constitute browser, external DB, or packaged-
  Windows acceptance.
* PR #29 CI for `9ee9e0af` is running; check the live PR before treating it as
  green. Existing local normalization files and `pnpm-workspace.yaml` remain
  uncommitted and untouched by these retry commits.
* Session mix and transition saves now use a local journal. An unacknowledged
  PATCH survives a tab reload and replays; the visible retry control clears a
  failed queue, and a track's pending save is forgotten only after deletion is
  acknowledged. The journal is per session and does not claim cross-tab locking.
* MIDI download uses the Buffer-returning encoder; its bytes remain covered by
  the format and round-trip unit tests.
* Drum, harmony, and vocal API routes now use their shared versioned
  idempotency-key helpers. The vocal key retains the existing `vocal:` prefix.
* Targeted Waveyard verification: 238/238 tests pass, including real-audio
  source analysis and the original comprehensive live-stem-layer suite; the
  workspace type check passes. These are not database, browser, or packaged
  Windows acceptance runs.
* **Superseded by the current local analysis implementation:** the local worker
  now registers drum, harmony, and vocal queues. Desktop API requests select
  the versioned `arena-js-stem-analysis` provenance and persist the same
  contracts as the remote NumPy jobs. Drums and vocals analyze isolated stems;
  harmony analyzes the source. PGlite plus filesystem-backed storage tests
  execute all three handlers through ffmpeg decode, verify result rows,
  provenance, attempts, failure/retry and restart requeue. DSP tests exercise
  transients, chord windows, pitch frames, silence, and honest unknown classes.
  The expanded Waveyard regression set (including the full live-stem-layer
  suite) passes 161/161; the separation suite passes 53 with one
  platform-specific skip. Workspace typecheck passes. This is synthetic/local
  integration evidence, not real-song listening, hosted-provider evidence, or
  packaged-Windows acceptance. Drum class labels remain unknown because the
  local detector measures transients but does not infer kick/snare/hat identity.
  Analysis cancellation is not currently exposed by these job routes.
* Waveyard → Core project attachment and artifact handoff now validate before
  writing, serialize concurrent first-time attachment with a PostgreSQL
  transaction lock, and persist each artifact plus its handoff record in one
  transaction. The real embedded-PostgreSQL API test proved blank-summary
  requests write no Core rows, two simultaneous attaches produce one project
  link, a forced handoff-row failure rolls back the artifact, and a valid
  handoff persists both rows and appears through both existing Core artifact
  readers. API-server typecheck passes. This verifies local database and API
  reader integration; it does not establish browser navigation or packaged
  Windows acceptance for the handoff flow.
* Desktop restart recovery now expires queued or taken agent-bridge tasks whose
  waiting API request was destroyed with the prior process. Rows and prompt
  provenance remain available for inspection, and late bridge completions are
  rejected instead of becoming stranded or detached answers. The bridge suite
  now runs against an isolated PGlite database with canonical desktop
  migrations (4/4 pass); shared-library and API-server typechecks pass. This
  proves local database lifecycle behavior, not real external-agent inference.
* Research mode previously kept web search local when Local Mode was enabled,
  but failed to pass `localOnly` into model generation; remote provider egress
  remained possible and the response was mislabeled as local. Research now
  propagates the no-egress flag and returns the generator's actual execution
  metadata. Two tests exercise the real model router with a fetch trap: zero
  web/model-provider requests in Local Mode and preserved on-device metadata.
  The shared-library and API-server typechecks pass. The local fallback is the
  deterministic engine, not a local language model.
* At `a66abe83`, the PR-triggered live-stem timing job reproduced WebKit's
  restore-button detachment after a tempo-matched vocals swap. The probe showed
  the button disappeared from the captured current deck; the recipient fixture
  was only 20 seconds long while the timing scenario played through several
  operations. The app correctly advances decks when audio ends. The harness
  change gives only the timing recipient a 90-second audio fixture, leaving the
  comprehensive live-stem regression fixtures unchanged.
  `node --check` passes. This Windows environment has no installed Playwright
  browser binaries, so the WebKit fix still needs CI confirmation before push.
* The same `a66abe83` PR and push package jobs failed while building the previous
  package, before reaching the update check: pinned SDL/SameBoy downloads failed
  (`HTTP 504` / `Could not acquire pinned SDL release`). This is evidence of an
  upstream artifact-fetch failure, not a failed installed-app update assertion.
  The installed-package update workflow therefore remains unverified at this
  head; rerun it when the pinned artifact service is available.
* A bounded retry now handles transient HTTP 408/425/429/5xx responses across
  pinned SDK ZIPs, classic package assets, and the SDL fixture download. Pins,
  exact sizes, digests, and permanent HTTP failure behavior remain enforced.
  Desktop build tests pass 7/7, including retry-on-504 and no-retry-on-404.
  The first post-change Windows run still failed on pinned GBDK/DOSBox 504s
  while compiling the *previous* package: the workflow builds from the base
  worktree and had not copied the new retry helper and recipes there. The
  workflow now explicitly applies those three pinned-download files to that
  baseline build while preserving its prior app source. The next Windows run
  must confirm it reaches installer, install, update, and restart checks.
* The original comprehensive Chromium live-stem run exposed a real status-order
  defect: a tempo-matched donor was reported only as low beat confidence,
  hiding that the tempo stretch had succeeded. The status now distinguishes a
  real stretch from 1.00× native tempo and reports unavailable beat alignment
  separately. Its existing browser
  assertions passed through the tempo, pitch-follow, playhead, and donor
  alignment checks. The Windows WebKit run cannot exercise audio because that
  browser build lacks `AudioContext`; the Chromium full run exits early after
  measuring zero output samples on mirror-tab return, while its context remains
  running. The harness records this as unsupported-environment evidence, so
  this is partial browser evidence, not a full-suite pass.

### Historical test evidence (earlier environment; no PostgreSQL/Redis)
Per-file `tsx --test` runs, branch `bbeefba1` vs pristine `main@33c876a`, same runner:

| | files | tests | pass | fail | skip |
|---|---|---|---|---|
| `main` | 243 | 1678 | 1536 | 108 | 33 |
| branch | 258 | 1813 | 1688 | 91 | 33 |

* +135 tests, +152 passing, **0 regressions**; 15 new files (all green), 2 files
  fixed (`claim`, `retry`).
* All 37 failing files on the branch also fail on `main` (need PostgreSQL, Redis,
  `initdb` or a live service). **Environment-blocked, not fixed, not caused here.**
* The 33 skips are identical on both trees.
* `pnpm run typecheck` passes. Later commits changed only `desktop/`, `scripts/`,
  the resume bound and its test (5/5 pass).

### CI evidence (historical; latest evidence is above)
* Windows recovered-stack acceptance: green on every commit.
* Windows x64 package (build → install → smoke → update): historically flaky.
  `1ce31981` push ✅ / PR ❌; `d8bc1430` PR ✅ / push ❌; `320223b3` both ✅;
  `0e9ef2b6` both ❌ (`current_package_starts`, window url `""`, loading);
  `96810e3a` both ✅ (first runs with the service-worker clear). Two consecutive
  greens are **not** proof the fix works at a ~50% failure rate. Require several
  consecutive greens before calling it fixed.
* Waveyard browser timing: historical logs correct an earlier misattribution.
  On `bbeefba1` (`42429844918`), `17420c42` (`42429724101`), and `96810e3a`
  (`42436016713`), Chromium and WebKit passed; Firefox failed during playback
  setup/resume. The only confirmed WebKit restore-control failure is the
  `d8bc1430` push run `42432274551`: WebKit found the restore button, then
  reported it unstable and detached during a 30-second click. That run predates
  the DOM mutation/geometry probes, so there is no evidence explaining why it
  detached. On `0e9ef2b6`, `77aef143`, `9a3a3dcb`, `32639378`, and `df6f1127`,
  push and PR browser runs passed. Repeated green runs show the failure is not
  currently recurring; they do not prove its root cause or a fix.

### Convergence verification
* Ledger accounting: GitHub currently lists 50 branches = 48 audited + `main` +
  this branch; 28 PRs = 27 audited + #29. Every one of the 48 is named in the
  ledger (abbreviated to the hash prefix or brace group).
* No branch was deleted; history was not rewritten; nothing merged to `main`.

### Remaining and owner decisions
1. **Content-object schema/route/reclamation** (`artifacts.content_object`,
   `object_reclamations`, two-grace reclamation): nothing consumes content
   objects (artifacts are text-only), so wiring would be dead code. Decide whether
   binary artifacts are a product requirement.
2. **PR #19 stricter Arcade gate** (input exercise, visual-change): not ported;
   could reject legitimate games. Also: the gate launches Chromium with
   `--no-sandbox` on Linux unconditionally.
3. **Arrangement/export**: `arrangement-pcm`/`arrangement-preparation` are
   superseded by main's streaming preview (`arrangement-preview-*`); porting
   would create a parallel path. `project-audio` needs DB acceptance first.
4. **Cancellation** (`cancelling` status, PR #26 `recovery.ts`): conflicts with
   main's broker cancel; design decision.
5. Branch protection / required checks on `main`.
6. Untested: real Demucs inference, GPU provisioning, audible playback, code
   signing, auto-update, whole-app shared identity and restart recovery with a
   real database.


## Product goal

One unified Arena OS, built on current `main` (pnpm workspace). Rooms: Core
(AI runtime, agents, missions, memory, governance), Spaces, Arcade, Waveyard
(music), Studio (media generation), Desktop (Windows app), plus Archive,
Congress, Classroom, Orchestrator. **A feature existing somewhere in the repo
is not the same as it working in the unified app.** Every room must correspond
to a working, verified capability.

## Ground rules

1. `main` is the canonical line. Do not merge old integration branches wholesale;
   recover capabilities into the current workspace instead.
2. Never delete branches, rewrite history or force-push shared branches. Old
   branches hold work and evidence.
3. A PR description must match its diff. Production-code changes are never
   "test only".
4. Do not claim something is verified unless a test or CI run proves it.
   Record unverified behaviour explicitly (see "Not verified").
5. Fail closed: invalid input or state must error, not silently fall back.
6. Pinned downloads (FFmpeg, SDL, etc.) must use immutable URLs with SHA-256.
   Do not re-pin to a moving tag.
7. Original Arena code is proprietary (see `LICENSE`). Do not paste it into other
   projects or add code with an incompatible licence.
8. Keep `README.md` and this file accurate. One focused PR per concern.

## Two facts about this repository that invalidate naive git measurements

Read these before drawing any conclusion from `git log` or branch counts.

1. **`main` is a single squashed root commit** (`33c876a`). Commit ancestry
   carries no meaning: every branch shares it as merge-base, so
   `main..branch` reports 100–340 "missing" commits for every branch and
   `git cherry` finds zero patch equivalence. Across the repo that reads as
   6,242 orphaned commits. **It is an artefact. Use content diffs.**
2. **The large branches are the pre-migration layout, not new work.** Every
   branch that looks big is a whole-tree copy of the old Next.js/npm app
   (`src/**`, `next.config.ts`, `electron-builder.yml`). Against today's tree
   they *delete* ~201,600 lines because they do not contain the pnpm
   workspace. The real question is always: *which `src/lib/**` capability has
   no counterpart under `lib/arena/src/lib/**` on `main`?* The union across all
   48 branches is **89 library paths** — that is the true recovery surface.

Full per-ref dispositions: `docs/BRANCH-PR-RECONCILIATION-LEDGER.md`.

## Priorities (in order)

1. **Land PR #28** (mashup fail-closed + Windows CI repairs) once Windows
   packaging and Waveyard browser acceptance are green.
2. **Land the convergence branch** `arena/convergence-2026-11-07` (based on
   PR #28's head). It contains the ported PR #26 capability stack, PR #27's
   recovered test coverage, and two pre-existing `main` defects fixed. Its
   delta versus `main` is measured: +99 tests, +116 passing, 0 regressions.
   It has not run on Windows — see "Not verified".
3. **Close the remaining recovery rows** in the reconciliation ledger §2.4.
   The two biggest are:
   - *artifact content objects + reclamation*: needs an `artifacts.content_object`
     column, an `object_reclamations` table, and two storage primitives
     (`putImmutableStream` with byte+sha binding, `StorageIntegrityError`) that
     `main`'s `StorageProvider` does not have. Do it as one migration + storage
     + route change, with tests, or not at all.
   - *Arcade browser-runtime publication gate*: `games/sandbox.ts` +
     `runtime-validation.ts` + the `validateRuntime`/`onDraft` contract in
     `forgeGameWithAI`. **Stale:** a gate already exists on `main`; see the top
     status section.
4. **Protect `main`**: no branch protection or rulesets exist. Require CI and
   review before merge.
5. **Prove the whole app**: shared identity/projects/storage across rooms,
   persistence, restart recovery, real provider execution, Windows install.

## Current state

- `main` = `33c876a` (5 Nov 2026, single squashed commit).
- **PR #28** `fix/mashup-bed-fail-closed-windows-tests` @ `aec18974`, 34 files
  ahead of `main`, clean descendant (0 main-only commits). Adds fail-closed
  instrumental-bed synthesis (`studio/mashup-bed.ts`), Windows packaging and CI
  repairs, and a capture-device guard.

  **Its Windows CI is `failure`, not green.** Every run on `aec18974` fails, on
  both the `push` and `pull_request` events:
  `installed-package` fails at step 10, *Build previous Windows package for
  update test*; steps 11–12 (*Build Windows x64 installer*, *Install and check
  packaged app*) are then **skipped**, so no PR #28 commit and therefore **no
  convergence-branch commit has ever had its installer installed and smoke
  checked by CI**. Earlier handoff text claiming that run was green was wrong
  and has been removed. See "CI status" below for the diagnosis.
- **`arena/convergence-2026-11-07`** — the convergence candidate. Built on
  `aec18974`, so it inherits PR #28 in full. Contains:
  - the complete `port/26-*` stack, in dependency order
    (`44a9570 → a4f69af → 6afc57e`) plus `port/26-command-process` (`ab99bf0`):
    separation client/modes/selection + Python guardian, resumable locked model
    seeding, `fs-replace`, deep-model provisioning
    (`provision`/`provision-store`/`provision-runtime`), bounded `run_command`
    with Windows tree-kill;
  - PR #27's regression coverage, without its production edits (see below);
  - fixes for two pre-existing `main` defects (see "Known defects on main").
- **`port/26-*` branches**: now superseded by the convergence branch, which
  contains their content. Keep them; do not delete.

## Known defects on `main` (fixed on the convergence branch)

1. **`desktop/runtime/migrate` did not exist**, yet five call sites imported it
   at three different relative depths. `claim.test.ts` and `retry.test.ts`
   failed with `ERR_MODULE_NOT_FOUND`, so **17 tests had never run**.
   `main`'s own harness (`worker-local/separation-fixtures.ts`) states the rule
   they broke: *"Tests must not import the desktop runtime, which is not part of
   the web workspace."* Fixed with
   `worker-local/pglite-migrations.test-helper.ts`. `retry` 0/11 → 11/11,
   `claim` 0/7 → 6 pass + 1 honest skip.
2. **PR #27's test file did not compile** — line 95 closed an object literal
   with `)`. Nothing in that PR had ever run.

## PR #27 — resolved, do not merge as-is

PR #27 (`arena/ed2f88f7`) was labelled test-only but changes
`session-logic.ts` and `mashup.ts`. Findings:

- Its test file does not compile, so none of it ran.
- With **only** that syntax error fixed, all 9 original assertions pass against
  **untouched `main`**. The production edits were unnecessary.
- They were also unsafe: they delete `hasReliableLiveStemTempoEvidence` /
  `hasReliableLiveStemBeatEvidence`, which `LiveStemSwapPicker.tsx` and
  `SessionExperience.tsx` import at 10 sites, and which
  `liveStemTempoStretchRatio` calls itself — the module would throw at import
  time. They also relax evidence thresholds (0.75→0.5, 0.6→0.3) and widen
  auto-stretch (0.8–1.25 → 0.75–1.5) on unverified evidence.

The convergence branch keeps the coverage
(`waveyard/studio/mashup-regression.test.ts`,
`waveyard/library/session-logic-key.test.ts`) and drops the production diff.

## Test evidence standard

Run the suite twice — once on a pristine `origin/main` worktree — and compare
per-file failure counts. Never attribute a failure to your work, or claim one
is fixed, without that comparison.

Current measurement (real `ffmpeg`/`ffprobe` available; no PostgreSQL/Redis):

| | tests | pass | fail | skip |
|---|---|---|---|---|
| `main@33c876a` | 1347 | 1237 | 93 | 17 |
| convergence branch | 1446 | 1353 | 76 | 17 |

The 76 remaining failures are identical per file to the baseline and need
PostgreSQL, Redis, a live browser or `initdb`. `pnpm run typecheck` passes.

## CI status — historical diagnosis, 2026-11-07 (STALE: see "Status at `3a782f73`" above)

Neither required workflow is green. Both failures are **inherited from
`main`**, not introduced by the convergence branch, and both are diagnosed
below from workflow-run and job-step data (not from logs — see the note at the
end of this section).

### `windows-package.yml` / `installed-package`

| run | sha | event | result |
|---|---|---|---|
| 42376054058 | `5fb2f72` | push | **success** (1.4k lines of work recovered, 13:14–13:29) |
| 42362246027 | `720a584` | push | **success** |
| (same commit `720a584`) | | pull_request | **failure** |
| — | `aec18974` | push and pull_request | **failure** |
| — | `b28d938` (this branch) | pull_request | **failure** |

Only **`push`** events have ever passed. On a pull_request run the job dies at
step 10, *Build previous Windows package for update test*, after ~30 s, while
the same step takes **4 minutes** and succeeds on push. Steps 11–12 (build
installer, install and smoke check) are skipped, so pull_request runs have never
validated an installed app.

**Diagnosis.** That step packages the *baseline* revision, chosen as
`pull_request.base.sha` on PR events (`main` → `33c876a`) or `github.event.before`
on push. `main` cannot be packaged by this workflow — two independent proofs:

1. `main` still carries `"esbuild>@esbuild/win32-x64": "-"` and
   `"@tailwindcss/oxide>@tailwindcss/oxide-win32-x64-msvc": "-"` in
   `pnpm-workspace.yaml`. PR #28's commit `2ec27f4` exists specifically to
   un-prune exactly those, so a Windows install from `main` is broken by design.
2. `desktop/native/waveyard-capture-host.cpp` on `main` lacks the Windows SDK
   header fixes made in `36a082c` (`propkeydef.h`) and `b7cd935`
   (`winrt/Windows.Foundation.h`).

So the "previous" build is a build of `main`, which does not build on Windows.
The push-only successes are not evidence of Windows readiness: a push whose
`before` sha is unavailable falls back to `git rev-parse HEAD^`, which on a
single-commit squashed `main` resolves to something other than `main`.

**Status (historical, superseded): the base-packaging causes were later fixed via the workflow base-fix list; see the top status section.** The fix requires a baseline
revision that can actually be packaged, which cannot be expressed from inside
this branch without changing what the update test means. Do not "fix" it by
making the step tolerate failure.

### `windows-recovered-stack.yml` — new, and green

No workflow previously ran `lib/arena` tests at all: the packaging workflow runs
only `desktop/*.test.mjs`, and none of those reference `fs-replace`,
`command-process`, `separation/seed` or `separation/provision`. The recovered
PR #26 stack therefore had **no CI coverage on any platform**.

This branch adds `windows-recovered-stack.yml`, which runs those ten test files
on `windows-latest` and **passes** (run `42378233941`, job `128420170775`,
`f505bd4`, 12 s of test time). To stop a silently skipping suite reading as a
pass, the job fails if the tree-kill test is absent from the output or reports a
skip, and raises a warning if the inference probe skips.

**This is real Windows evidence for the recovered stack's process/filesystem/
seeding/validation behaviour** — the first it has ever had. It is *not* evidence
of real audio inference (no ffmpeg or GPU on the runner) and it is not evidence
that the Windows installer works, because that is the other job.

### `waveyard-browser-timing.yml` / `live-stem-timing`

**RESOLVED — the matrix now passes on all three engines** (run `42386675911`,
`6a0ba64`, job `live-stem-timing` = **success**, every step green including the
new audio-sink step). This section records what was wrong, because two of the
explanations offered earlier in this file were wrong and one of them was wrong in
a way that made the next diagnosis harder.

| run | sha | result |
|---|---|---|
| 42376858283 | `867c538` | fail, 100 s |
| 42377175538 | `b28d938` | fail, exactly 60 s (Vite readiness) |
| 42378234049 | `f505bd4` | fail, 72 s — readiness annotation did **not** fire |
| 42378819685 | `66dba41` | fail — *matrix failed* (so readiness + persistence passed) |
| — | `7af676b` | fail — `LIVE_STEM_TIMING_ENGINE firefox exited with status 1` |
| — | `c75d9df` | fail — `TimeoutError` at `waveyard-live-stems.mjs:2030` |
| — | `675ef64` | fail — `pressed:"false"`, elements `readyState 4`, no media error |
| — | `d204052` | fail — context `suspended`, `playStarts: []`, `playRejections: []` |
| 42381290508 | `b80b368` | fail — `visibleError`: *can't access property "find", next.devices is undefined* |
| 42381843655 | `da56f1e` | fail — probe annotation corrupted by raw audio bytes |
| 42382362100 | `49b0da0` | fail — `contextResumes: []`, still no error |
| 42382740991 | `4e22a86` | fail — `contextResumes: [{outcome:"still-pending", pendingForMs:2999}]` |
| 42385321180 | `3be2a1e` | fail — a **brand-new** context also stays pending; `userActivation.hasBeenActive: true` |
| 42385847628 | `d6132b3` | fail — honest error now shown; sink step silently did nothing |
| 42386286296 | `08f5631` | fail — **Firefox passes**, WebKit `TimeoutError` |
| 42386675911 | `6a0ba64` | **success — chromium, webkit and firefox all pass** |

**The actual cause, in two halves.**

*Environment.* The runner had no audio device. Firefox suspends a Web Audio
graph when there is nowhere to play it; Chromium and WebKit run theirs anyway,
which is precisely why only one engine failed. Proven, not inferred, from a
failure-time probe in the page (`3be2a1e`):

```
directResume   "suspended -> pending-after-1500ms (state now suspended)"
freshResume    "suspended -> pending-after-1500ms (state now suspended)"
userActivation {"isActive": true, "hasBeenActive": true}
workletLoads   [{"outcome":"resolved","settledAfterMs":35}]
```

A **brand-new** `AudioContext` could not resume either, while
`AudioWorklet.addModule` on the same context finished in 35 ms. So it was not an
autoplay refusal (the page had been activated and the Firefox prefs already set
`media.autoplay.default: 0`) and not the app's own context being wedged. The
workflow now installs `pulseaudio` (the *daemon* — installing only
`pulseaudio-utils`, the clients, was a first attempt that reported success and
created no sink), starts it with `-n` and an anonymous-auth unix socket, loads a
`module-null-sink`, and passes `PULSE_SERVER` to the matrix step. The step warns
via `::warning::` if any part of that fails, so it cannot silently no-op again.

*Application.* `await context.current.resume()` was unbounded. A resume promise
is allowed never to settle, and this one did not: Play stopped at the await with
no playback, no error, and a Playing control that never engaged — a dead button.
`resumeWithin()` (`lib/arena/src/lib/waveyard/audio-context-resume.ts`) bounds
the wait; the caller then inspects `state` and reports *"Audio playback was
interrupted. Activate Play stems to resume. If this persists, check that this
device has a working audio output."* That is what the Firefox leg showed at
`d6132b3`, before the sink existed: the failure became legible to a user instead
of a 30 s silence. Four regression tests, and they run in CI.

*Third defect, found on the way.* `AudioCaptureWorkbench` is mounted
unconditionally in `MusicHome`, so it calls `/api/library/audio-capture` on the
session page too. Nothing serves that route in this harness and the SPA fallback
answers with `index.html`, so the body was never capture options. The component
cast it to `CaptureOptions` and called `next.devices.find(...)`, which threw
`can't access property "find", next.devices is undefined` out of a refresh
effect. `parseCaptureOptions` now validates the shape and reports an error
instead. Six tests.

**Corrections to this file's own earlier claims.** It asserted "Chromium and
WebKit pass, Firefox fails" with no evidence, then asserted the throw at
`useStemTransport.ts` L846–849 was the cause (it required `resume()` to *settle*
and leave the state non-running — it never settled at all), then read
`contextResumes: []` as "resume() was never called" when the probe only recorded
settlements and could not distinguish "never called" from "called and never
returned". Each was written down as established fact. They were not. The probe
now records calls synchronously and marks a promise still-pending after 3 s,
which is why the last three rows above are decisive where the earlier ones were
not.

**No timeout, assertion or gate was relaxed.** The 30 s `waitForFunction` is
unchanged; the failure moved from "some engine times out" to "all three engines
pass".

### Why the cause is not being quoted from CI logs

Job logs are unreachable from the environment this work ran in:
`productionresultssa*.blob.core.windows.net` and
`results-receiver.actions.githubusercontent.com` are both outside the sandbox's
network allowlist, and check-run annotations contain only
"Process completed with exit code 1." The diagnoses above come from workflow
definitions, step timings, event/result correlation across runs, and local
reproduction of Vite. Re-read the logs when they are reachable; if they
contradict this, they win.

## Not verified (do not claim otherwise)

- **The ported PR #26 slices now run on Windows**, via
  `windows-recovered-stack.yml`, which passes. What that does *not* prove:
  real Demucs inference (no ffmpeg/GPU on the runner — the job emits an
  `::warning::` saying the inference probe was skipped and that real inference is
  therefore NOT proven), and the packaged installer, which is the other, still
  failing job.
- Real Demucs inference on Windows, GPU model provisioning, audible playback via
  hardware, GUI mixer interaction, human-driven Arcade/Spaces flows on Windows,
  code signing, auto-update.
- **The full browser matrix passes only on this harness**, on `ubuntu-22.04`
  with a PulseAudio null sink. That is genuine cross-engine evidence for
  Chromium, WebKit and Firefox playback/timing on Linux. It is not evidence of
  audible playback through real hardware, and not Windows or iOS evidence.
- The Waveyard browser matrix covers the live-stem timing scenarios only; the
  other `waveyard-*.mjs` scripts are not run by this workflow.
- Database/migration acceptance: no PostgreSQL or Redis here.
- PR #26's six green Windows jobs (1,649 tests) are evidence **for the old
  npm/Electron layout only**. Never cite them as proof that ported code works.
- Hosted-runner results are not a substitute for the owner's Windows 11 machine.

## Handoff checklist for each session

1. Read §"Two facts about this repository" before trusting any git metric.
2. Check which of PR #28 / the convergence branch has landed.
3. Pick the highest open priority that you can actually prove.
4. Add a test that fails without your change and passes with it.
5. Measure against a pristine `origin/main` worktree; record both numbers.
6. Update this file and the reconciliation ledger in the same PR.
7. Never delete a branch or force-push.
