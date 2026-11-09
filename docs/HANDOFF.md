# Arena handoff — read this first

Living document for every human or AI agent working on Arena. **Update it in
the same PR as any change that alters status, priorities or the ledger.**
Last updated: 2026-11-09.

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
