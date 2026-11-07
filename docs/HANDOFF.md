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

### `waveyard-browser-timing.yml` / `live-stem-timing`

| run | sha | step 7 duration | result |
|---|---|---|---|
| 42376858283 | `867c538` | 100 s | failure |
| 42377175538 | `b28d938` | **exactly 60 s** | failure |

Steps 1–6 pass, including the Playwright browser install. Step 7,
*Run cross-browser live-stem timing matrix*, fails. Its first 60 s is the
workflow's own Vite readiness loop (`for _ in $(seq 1 60)` … `sleep 1`), which
gives up when `curl http://127.0.0.1:80/` never succeeds.

**What is established:** Vite never becomes reachable on port 80 on the runner,
so the browser matrix never runs — the engine order is chromium → webkit →
firefox, so **no engine is exercised at all** and this says nothing about
Firefox audio readiness.

**What has been ruled out locally:** the `sudo env PATH=… PORT=80 BASE_PATH=/ …`
invocation is *not* the bug. It passes `PORT` correctly, and with the exact same
argument form Vite serves `200` in ~0.2 s here. A missing `PORT` does produce
the expected hard throw, so that failure mode is distinguishable — and it is not
what the runner reports.

**Remaining candidate:** binding port 80 as a non-root process on the runner
(with an `EACCES` visible only in the stranded `waveyard-vite.log`). This is not
yet proven.

**Status: root cause NOT established.** To make the next failure self-explaining
this branch adds, on the readiness-loop failure path, a `::error::` annotation
plus the Vite log, `ss` listeners on `:80`, the `pgrep` process list, a `curl`
result and a passwordless-`sudo` probe. The next run will state its own cause in
the check-run annotation. **No acceptance criterion was relaxed**; the job still
fails exactly as before, it just explains why.

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

- **The ported PR #26 slices have never run on Windows.** They are green on
  Linux only, and Windows behaviour is the whole point of `fs-replace`
  (`EPERM`/`EACCES`/`EBUSY` retry) and `command-process` (tree-kill).
- Real Demucs inference on Windows, GPU model provisioning, audible playback via
  hardware, GUI mixer interaction, human-driven Arcade/Spaces flows on Windows,
  code signing, auto-update.
- Firefox Waveyard timing (see above).
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
