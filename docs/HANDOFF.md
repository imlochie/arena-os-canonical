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
  repairs, and a capture-device guard. CI: **Windows x64 package** push run
  green (installed-app smoke incl. backup/restore round trip, tamper rejection,
  update check). **Waveyard browser timing: Chromium and WebKit pass; Firefox
  fails** (`--live-stem-timing-matrix`: audio elements never reach readyState 4
  within 15 s). Never green; cause unconfirmed.
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
  `SessionExperience.tsx` import (3 call sites) and which
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
