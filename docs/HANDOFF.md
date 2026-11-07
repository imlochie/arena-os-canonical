# Arena handoff — read this first

Living document for every human or AI agent working on Arena. **Update it in
the same PR as any change that alters status, priorities or the ledger.**
Last updated: 2026-11-07.

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
     `forgeGameWithAI`. Genuinely missing and a real truthfulness gap; needs a
     real browser to prove.
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

## CI status — diagnosed from run data, 2026-11-07

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

**Status: root cause identified, not yet fixed.** The fix requires a baseline
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
