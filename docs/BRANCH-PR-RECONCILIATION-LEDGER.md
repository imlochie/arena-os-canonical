# Branch and PR reconciliation ledger — 2026-11-07

Scope: every remote branch (48) and every pull-request ref (27) in
`imlochie/arena-os-canonical`, audited against **current `main` at
`33c876ae6da0adff2dc362e8c0bd339f93495649`**, not against the older
integration candidate `13638fe`.

This file is the evidence behind the convergence branch
`arena/convergence-2026-11-07`. It exists because the October convergence
ledger on PR #26 established that PRs #1–#25 were reconciled *against
`13638fe`* — a candidate that is not today's canonical baseline. That ledger is
historical evidence, not proof that anything is present in `main`.

## 0. Two structural facts that invalidate the obvious measurements

Both were discovered during this audit and both change how every row below must
be read.

**`main` is a single root commit.** `git rev-list --count origin/main` returns
`1`. Its history was squashed into one snapshot
(`33c876a "Keep restored-source analysis and waveform data checksum-accurate"`).
Commit *ancestry* therefore carries no information: every branch shares that one
commit as its merge-base, so `git rev-list --count main..branch` and
`git cherry` report every branch as "ahead by 100–340 commits" with zero patch
equivalence. **Measured naively, the repository claims 6,242 orphaned commits.**
All of it is an artefact. Content diff is the only valid measure.

**The large branches are pre-migration layout, not additive work.** Every
branch that looks huge is a whole-tree copy of the old Next.js/npm app:

| | `main` (current) | the big branches |
|---|---|---|
| framework | pnpm workspace | Next.js + `electron-builder.yml` |
| app code | `lib/arena/src/lib/**`, `artifacts/**` | `src/**` |
| LOC | ~1,691 files | ~2,785 files, **−201,600 net** |

They are not "ahead of main with 200k new lines". Against today's tree they
*delete* ~201,600 lines, because they do not contain the pnpm workspace at all.
Those 1,650 "extra" files are the old `src/` tree — old-layout duplicates of
capabilities `main` already has in `lib/arena/src/lib/`.

So the working question is never "is this branch ahead?" but **"which
capabilities exist in this branch under `src/lib/**` that have no counterpart
under `lib/arena/src/lib/**` on `main`?"** Answering that for all 48 branches
yields a union of **89 distinct library paths** — the entire real recovery
surface of this repository (not 6,242 commits).

## 1. Method

1. `git fetch` of all `refs/heads/*` and all `refs/pull/*/head`.
2. Full `--shortstat` diff of every branch against `origin/main`.
3. Path-mapping (`src/lib/X` → `lib/arena/src/lib/X`) to compute, per branch,
   which old-layout library files have no counterpart on `main`; union of all
   branches = 89 paths.
4. For each of those, compare against `main`'s actual implementation under
   whatever name it uses, because renaming ≠ absence.
5. For every candidate port: apply it, then run its tests **on this baseline**.
6. Compare full-suite results against a pristine `origin/main` worktree so that
   every failure is attributed to either pre-existing breakage or this work.

Evidence artefacts for step 6: `tests=1347 pass=1237 fail=93 skip=17`
(baseline) vs `tests=1446 pass=1353 fail=76 skip=17` (this branch).

## 2. Dispositions

Legend: **RECOVERED** (capability now present in this branch, with passing
tests) · **PRESENT** (already on `main`; evidence given) · **SUPERSEDED**
(replaced by a newer implementation on `main`) · **PRESERVED_PENDING** (real,
missing here, deliberately not attempted in this change, with the blocker
named) · **NOT_ADOPTED** (examined, rejected, with the reason).

### 2.1 The port/26-* bridge (previously unverified work)

These five branches are the port of PR #26's Windows hardening onto the pnpm
workspace. The handoff stated they were "typecheck clean, tests pass locally,
NOT yet run on Windows", stacked on PR #28. They were never independently
audited, and their work was in no `main`-based branch.

| Ref | Head | Capability | Destination on this branch | Evidence | Disposition |
|---|---|---|---|---|---|
| `port/26-waveyard-provision` | `6afc57e` | Deep-engine provisioning: `provision.ts`, `provision-store.ts`, `provision-runtime.ts` + tests | `lib/arena/src/lib/waveyard/separation/provision{,-store,-runtime}.ts` | 13+11+23 tests pass | **RECOVERED** |
| `port/26-waveyard-seed` | `a4f69af` | Resumable, locked, Windows-safe model seeding + `fs-replace` | `separation/seed.ts`, `fs-replace.ts` | 9 + 4 tests pass; 15 HTTP-resume tests pass | **RECOVERED** |
| `port/26-waveyard-clean` | `44a9570` | Separation client/modes/selection, Python process guardian | `separation/{client,modes,selection,python-guardian}.ts` | 3+2+3 tests pass | **RECOVERED** |
| `port/26-command-process` | `ab99bf0` | Bounded `run_command` with Windows tree-kill | `lib/arena/src/lib/spaces/command-process.ts` | 4 tests pass | **RECOVERED** |
| `port/26-fs-replace` | `56b1b44` | Windows-tolerant atomic replace | `lib/arena/src/lib/fs-replace.ts` | 4 tests pass (subset of `-seed`) | **RECOVERED** |

Note on the stack: `-provision` ⊃ `-seed` ⊃ `-clean`, and `-seed` already
contains `-fs-replace`. This branch carries the full stack plus the independent
`-command-process` slice, in dependency order:
`44a9570 → a4f69af → 6afc57e → ab99bf0`.

The `port/26-*` branches also carried PR #28's 22 Windows-ci/smoke commits.
Those come along via this branch's base (see 2.3).

### 2.2 PRs #27 and #28

| Ref | Disposition | Detail |
|---|---|---|
| PR #27 `arena/ed2f88f7` `0118391f` | **NOT_ADOPTED** (production) / **RECOVERED** (tests) | Described as test-only; its diff changes `session-logic.ts` and `mashup.ts`. Its test file **does not compile** — line 95 closes an object literal with `)` — so none of it had ever run. With only that syntax error fixed, all 9 original assertions pass against **untouched** `main`. The production edits were therefore unnecessary, and were also unsafe: they delete `hasReliableLiveStemTempoEvidence` / `hasReliableLiveStemBeatEvidence`, which 2 UI components import at 10 sites and `liveStemTempoStretchRatio` itself calls, and they relax evidence thresholds 0.75→0.5 and 0.6→0.3. Coverage kept (split to `mashup-regression.test.ts` + `session-logic-key.test.ts`), production diff dropped. |
| PR #28 `fix/mashup-bed-fail-closed-windows-tests` `aec18974` | **RECOVERED** (whole PR, as base) | Clean descendant of `main` (0 main-only commits), so this branch is built directly on `aec18974`. Brings `mashup-bed.ts` (fail-closed instrumental-bed synthesis: refuses cross-run / cross-source / misaligned stems, applies headroom instead of clipping), 9 tests, Windows packaging + CI repairs, and the Firefox capture-device guard. **Its CI is still the required evidence** — see §5. |

### 2.3 Work already present on `main` (checked, not assumed)

| Capability | Source refs that appeared to hold it | Evidence it is on `main` |
|---|---|---|
| Arcade + Spaces integration foundation | PR #25 `13638fe`, `arena/331aa502` `04705ab` | `lib/arena/src/lib/spaces.ts` (`runSpace`, `runFleet`, `createSpace`…), `spaces/*.ts` (governance, browser, workspace-isolation, tools), `games/*.ts` |
| Waveyard separation/client/deep/retry/recovery | `arena/331aa502`, PR #5, #3, #6 | `separation/{client,deep,retry,recovery-equivalent,session,claim,cancel,seed}.ts` present and tested |
| Waveyard library/session/studio | many | `library/service.ts`, `session-logic.ts`, `studio/mashup.ts`, `mixer/`, `measure/` |
| Studio (WanGP/ComfyUI/hosted/BYOK) | PR #1 | `lib/arena/src/lib/studio/{catalog,comfyui,demo,hosted,jobs,wangp}.ts` |
| Converted-audio batch ZIP | PR #17 (merged) | `routes/download.ts`, `http` range handling in `imported/exports/[id]/media` |
| Failure-draft retention for the AI forge | PR #19 | `games/forge-ai.ts` already carries `draft` + `validation` on failure |
| SSRF / outbound URL policy | PR #10 `safe-fetch.ts` | `security/outbound-url.ts` — strictly newer: DNS-rebinding, multi-record answers, IPv4-mapped/NAT64/6to4 aliases, per-hop redirect revalidation. `safe-fetch.ts` is **SUPERSEDED**. |
| Windows packaging / desktop acceptance | PRs #7, #9, #8 (merged) | `desktop/` suite + PR #28 repairs |
| PostgreSQL recovery, capabilities resolver, API hardening | PR #11 (merged) | `capabilities/{probes,report,resolver}.ts`, `waveyard/library/pg-readiness.ts` |

### 2.4 Preserved pending — real work, deliberately not attempted here

> Updated 2026-11-08 (see `docs/HANDOFF.md` "Status at `3a782f73`"):
> * Arcade gate — **already present on `main`** (`runtime-verification.ts`, all three publish paths); hardened here with a uniform-canvas check and tests. PR #19's stricter checks remain an owner decision.
> * Content objects — storage primitives **implemented** (`putImmutableStream`, `verifyObject`, `StorageIntegrityError`, 10 tests); column/table/reclamation still pending (no consumer).
> * `arrangement-pcm`/`arrangement-preparation` — **superseded** by `arrangement-preview-*`; not ported.
> * `project-audio` — pending DB acceptance. Cancellation — owner decision.

| Capability | Source ref | Why not now |
|---|---|---|
| Immutable artifact content objects (`artifact-objects`, `artifact-storage-lock`, `artifact-input`) + `artifacts.content_object` column + `ArtifactContentObject` type | `arena/331aa502`, PR #25/#26 | Needs a schema migration on `artifacts` (absent on `main`) **and** two storage primitives `main`'s `StorageProvider` does not expose — `putImmutableStream` (dedup, byte+sha bound) and `StorageIntegrityError`. That is a storage-layer feature plus migration plus route rewiring, not a copy. |
| Two-grace artifact reclamation (`artifact-reclamation`, `artifact-object-recovery`) + `object_reclamations` table | `arena/331aa502` | Strictly downstream of the row above; the reclamation ledger table does not exist on `main`. |
| Arcade browser-runtime publication gate (`games/sandbox.ts`, `games/runtime-validation.ts`, and the `forgeGameWithAI` contract carrying `validateRuntime` / `onDraft` / `ForgeDraftError` / `runtimeValidation`) | PR #19 `product/arcade-runtime-validation` | Genuinely missing and a real truthfulness gap: it sandboxes untrusted game HTML and retains the failed draft. But it restructures `forgeGameWithAI`'s result and threading, and its end-to-end proof needs a real Playwright browser, which cannot run in this environment. Porting it unverified would itself be an unproven capability claim. |
| Durable `cancelling` job status, PR #26 `recovery.ts`, `onSpawn` pid record | PR #26 | Conflicts with `main`'s broker-based cancel design (`separation/cancel.ts`). A deliberate design decision is required, not a merge. |
| `spaces/{mission-plan,mission-runtime,mission-memory,mission-evidence,mission-outputs}` | PRs #20, #21, #23, #24 | `main` spans the same ground through `spaces.ts` + `workforceResolver.ts`. Porting the older module family would create a second mission-runtime path, which the task forbids. Needs a per-capability diff and a consolidation decision. |
| `waveyard/{arrangement-pcm,arrangement-preparation,export-bundle,project-audio}` and `library/session-save-queue` | PR #15 lineage | No counterpart on `main`; each needs its own behavioural comparison against `arrangement*`/`export` equivalents. Not enough signal in this pass to port without risking a duplicate persistence path. |
| `spaces/{browser,external,governance,spaces-tools}` **tests** | `arena/331aa502` | The modules are on `main`, but their tests import the same non-existent `desktop/runtime/migrate` and need a live browser/DB. Test restoration, not capability recovery. |
| PR #26 Windows evidence (six green Windows jobs, 1,649 tests) | PR #26 `2fdacae` | Historical evidence **for the old npm/Electron layout only**. It is not evidence that ported code works on this workspace or on Windows. Retained as history; explicitly not cited as proof. |

### 2.5 Remaining branches — no unique capability beyond the above

All refs below are pre-migration-layout trees whose library content is either
duplicated on `main` or belongs to one of the rows in 2.4. None had a unique
`src/lib/**` path outside the 89-path union already dispositioned. Recorded so
that no ref is silently dropped.

`arena-rooms-handoffs` · `arena/01a09640` · `arena/01a0a9b7` (PR #1) ·
`arena/01a0b544` · `arena/01a0bb55` · `arena/01a0bdc9` · `arena/01a0bebf` ·
`arena/01a10c30` (PR #2, merged) · `arena/208e8a9c` · `arena/331aa502` (PR #15) ·
`arena/4fa4a9aa` (PR #5) · `arena/6e5aab6e` (PR #14) · `arena/7860da1d` (PR #8,
merged) · `arena/7e7916ff` (PR #11, merged) · `arena/84676e63` (PR #28 base) ·
`arena/a7466e3a` (PR #3) · `arena/a76da1f7` (PR #6, closed) ·
`arena/c887bce3` (PR #13, merged) · `arena/conversion-batch-download` (PR #17,
merged) · `arena/ed2f88f7` (PR #27) · `arena/integration-candidate-2026-10-21`
(PR #25) · `arena/spaces-fleet-resolution` (PR #24) ·
`arena/spaces-selected-model` (PR #23) ·
`arena/windows-ready-integration-2026-10-22` (PR #26) ·
`benchmark/waveyard-{encoded-recovery,hybrid-ownership,incremental-pcm,peak-recovery,postrender-eviction}` ·
`copilot/arena-os-final-reconciliation` · `feat/spaces-aria-snapshot` ·
`fix/db-setup-utf8-mainline` (PR #4, merged) · `fix/pg-recovery-hardening` (PR #10) ·
`fix/windows-desktop-packaging-acceptance` (PR #7, closed) ·
`fix/windows-packaging-after-pr8` (PR #9, merged) ·
`product/arcade-rule-save-reopen` (PR #22) · `product/arcade-runtime-validation`
(PR #19) · `product/arcade-spaces-capabilities` (PR #21) ·
`product/converter-waveyard-flow` (PR #18) · `product/spaces-workshop-proof`
(PR #20) · `replit/waveyard-memory-ownership` (PR #16)

## 3. Defects found on `main` while auditing (fixed here)

Both were pre-existing and both made tests unrunnable rather than merely red.

1. **`desktop/runtime/migrate` does not exist.** Five call sites imported it at
   three different relative depths. `claim.test.ts` and `retry.test.ts` failed
   with `ERR_MODULE_NOT_FOUND`, so **17 tests had never executed**. `main`'s own
   working harness (`worker-local/separation-fixtures.ts`) documents the rule
   they broke: *"Tests must not import the desktop runtime, which is not part of
   the web workspace."* Both fixtures already used PGlite, so the `pg.Client`
   cast they passed was also wrong. Fixed with
   `worker-local/pglite-migrations.test-helper.ts` (PGlite + real-`pg`
   variants); `retry` 0/11 → 11/11, `claim` 0/7 → 6 pass + 1 honest skip.
   `mediaArchive/testIsolation.ts` got the same repair.
2. **PR #27's test file did not compile** — see 2.2.

## 4. Current test evidence for this branch

Against a pristine `origin/main` worktree, same runner, same environment
(real `ffmpeg`/`ffprobe` supplied; no PostgreSQL/Redis available):

| | tests | pass | fail | skip |
|---|---|---|---|---|
| baseline `main@33c876a` | 1347 | 1237 | 93 | 17 |
| `arena/convergence-2026-11-07` | 1446 | 1353 | 76 | 17 |

* +99 tests, +116 passing, **0 regressions**, 17 files fixed.
* 11 new test files, all green (92 of the added tests).
* The 76 remaining failures are byte-identical in count per file to the
  baseline. They require PostgreSQL, Redis, a live browser, or `initdb`
  binaries that this environment does not have. **They are not caused by this
  branch and are not claimed as fixed.**
* `pnpm run typecheck` passes across all workspace projects.

## 4a. CI on the convergence branch (historical; current evidence is in `docs/HANDOFF.md` "Status at `3a782f73`")

Both required jobs fail **on PR #28's head as well as on this branch**, in the
same window: `installed-package` at step *"Build previous Windows package for
update test"*, and `live-stem-timing` at *"Run cross-browser live-stem timing
matrix"*. This branch's own commits change no `.github/`, `desktop/` or
`scripts/waveyard-live-stems.mjs` file, so it neither causes nor fixes them.
Their cause is not established — job logs were unreachable from the audit
environment. Treat the Windows packaging path as **not green**.

## 4b. Follow-up verification (2026-11-07, second pass)

Branch head `3a9636d` on `arena/convergence-2026-11-07`. Everything below is
new since the first pass.

### Corrected documentation

`docs/HANDOFF.md` claimed PR #28's Windows package run was green including
installed-app acceptance. It was never green: every run on `aec18974` fails on
both events at step 10, and steps 11–12 (*Build Windows x64 installer*,
*Install and check packaged app*) are then skipped. Claim removed. The same
document's unsupported "Chromium and WebKit pass, Firefox fails" statement was
also removed — it was never evidenced, and the run at `f505bd4` shows the
`live-stem-timing` job fails before any browser engine is exercised.

### Windows CI that did not exist

No workflow ran `lib/arena` tests on any platform. The recovered PR #26 stack
therefore had zero CI coverage despite every module being Windows-specific.
Added `windows-recovered-stack.yml`: ten test files on `windows-latest`,
per-file evidence, and a hard requirement that the tree-kill test actually
execute rather than skip. **Passes** — run `42378233941`, job `128420170775`.

### Stronger proof of the tree-kill property

`command-process.test.ts` used leaf children that die on their own, so it never
exercised the case the primitive exists for. Added a test that spawns a real
grandchild holding the inherited pipes; a mutation that disables both the
process-group kill and `taskkill` makes it fail naming the regression, and a
watchdog makes that failure fast rather than a hang.

### CI diagnosis status, stated precisely

Updated after the third pass (see §4c). The two rows that were open here are now
closed.

| job | status |
|---|---|
| `installed-package` | cause **identified, not fixed**: the step packages the PR base (`main`), which cannot be packaged (win32-x64 still pruned; missing SDK header fixes). Only `push` events have ever passed. Fixing it changes what the update test compares, so it is left as a decision for the owner rather than quietly re-pointed at another commit. |
| `live-stem-timing` | **fixed and passing** on all three engines. Root cause was environmental (no audio device on the runner) plus an unbounded `AudioContext.resume()` in the app. See §4c. |
| `recovered-stack` (new) | **passes** on Windows, now with twelve test files. |

### Test totals at `3a9636d`

| | tests | pass | fail | skip |
|---|---|---|---|---|
| baseline `main@33c876a` | 1347 | 1237 | 93 | 17 |
| this branch | 1447 | 1354 | 76 | 17 |

Zero regressions; every remaining failure is identical per file to the baseline.

## 4c. Third pass (2026-11-07): the browser matrix, actually solved

Branch head `addc1ee`. This closes `live-stem-timing`, which every previous pass
left open, and records why the earlier diagnoses were wrong.

### What was wrong

| pass said | reality |
|---|---|
| "Vite never starts" | Vite was fine; readiness succeeded (`f505bd4` ran 72 s, not 60, and the readiness annotation never fired). |
| "the throw at `useStemTransport.ts` L846–849 is the cause" | It required `resume()` to **settle** and leave the context non-running. It never settled at all. |
| "`contextResumes: []` proves `resume()` was never called" | The probe recorded only settlements, so "never called" and "called and never returned" were indistinguishable. It was the second. |

Each of those was recorded as established fact at the time. The lesson is in the
probe, not the prose: **an absence is not an observation.** The probe now pushes
an entry synchronously at call time and marks it `still-pending` after 3 s, which
is the change that made the cause visible.

### The cause, proven in the page at failure time

At `3be2a1e`, on the Firefox leg, with the page in the exact state where Play had
stalled for 30 s:

```
directResume   "suspended -> pending-after-1500ms (state now suspended)"
freshResume    "suspended -> pending-after-1500ms (state now suspended)"
userActivation {"isActive": true, "hasBeenActive": true}
workletLoads   [{"outcome":"resolved","settledAfterMs":35}]
```

A **brand-new** `AudioContext().resume()` never settled, so this was not the
app's context being wedged. The page had real user activation and Firefox already
ran with `media.autoplay.default: 0`, so this was not an autoplay refusal.
`AudioWorklet.addModule` resolved on the same context in 35 ms, so the audio
thread was alive. The remaining explanation is the one the data supports: **the
runner had no audio output device**, and Firefox suspends a Web Audio graph when
there is nowhere to play it. Chromium and WebKit run theirs regardless, which is
exactly why one engine failed and two did not.

### The three fixes

1. **Environment** (`waveyard-browser-timing.yml`): install the `pulseaudio`
   *daemon* (a first attempt installed only `pulseaudio-utils`, the clients, and
   reported success while creating no sink at all), start it with `-n` and
   `auth-anonymous=1` on an explicit unix socket, load a `module-null-sink`, pass
   `PULSE_SERVER` to the matrix step. Failures surface as `::warning::` so the
   step cannot silently no-op a second time.
2. **Application** (`audio-context-resume.ts`, used by `useStemTransport.ts`):
   `resumeWithin()` bounds the wait, and the caller checks `state` and reports
   *"Audio playback was interrupted. Activate Play stems to resume. If this
   persists, check that this device has a working audio output."* Before this,
   an app user with no working output device got a button that did nothing, no
   error, forever.
3. **Application** (`audio-capture-options.ts`, used by
   `AudioCaptureWorkbench`): the capture-options body is validated instead of
   cast. `next.devices.find(...)` on an unvalidated body threw
   `can't access property "find", next.devices is undefined` out of a refresh
   effect, because `AudioCaptureWorkbench` is mounted unconditionally in
   `MusicHome` and this harness does not serve that route.

### Evidence

| | |
|---|---|
| browser matrix | run `42386675911` @ `6a0ba64` — **success**, chromium + webkit + firefox, all 8 steps green |
| regression tests | `audio-context-resume.test.ts` 4/4, `audio-capture-options.test.ts` 6/6 — both now run in the Windows `recovered-stack` job, not just locally |
| suite, whole repo | baseline `main@33c876a` 1347 tests / 1237 pass / 93 fail / 17 skip → this branch 1451 / **1358** / 76 / 17. **Zero regressions**; no file fails more than on main; all 13 added test files green |
| typecheck | `pnpm run typecheck` — all four projects, exit 0 |

No assertion, timeout or gate was relaxed anywhere in this pass. The 30 s
`waitForFunction` that was timing out is unchanged.

## 5. What is still not proven

Do not read §4 as acceptance.

* **Windows packaging / installed-app**: package, install and smoke pass; the
  update check passes intermittently (~50% failure before `96810e3a`). Not yet
  proven reliable — see HANDOFF status section.
* **The ported PR #26 slices run on Windows and pass** (`recovered-stack`).
  Not covered by that: real Demucs inference (the job warns that the inference
  probe was skipped and says real inference is NOT proven), and the packaged
  installer, which is still failing.
* **Real Demucs inference, GPU provisioning, audible playback, code signing,
  auto-update, GUI mixer**: unverified, unchanged.
* **Firefox Waveyard timing: resolved** — see §4c. The matrix passes on
  Chromium, WebKit and Firefox in most runs; intermittent push-event failures
  remain (HANDOFF status section). What that does not establish: audible playback
  through real hardware (the runner uses a PulseAudio null sink), Windows or iOS
  browser behaviour, or the other `waveyard-*.mjs` scripts, which this workflow
  does not run.
* **Database/migration acceptance**: no PostgreSQL or Redis in this
  environment, so the 76 pre-existing failures cannot be closed here.

## 6. Addendum 2026-11-08

* Test comparison, per-file, branch `bbeefba1` vs `main@33c876a`: 1813/1688/91/33
  vs 1678/1536/108/33 (tests/pass/fail/skip). 0 regressions; 37 failing files are
  identical on both trees (PostgreSQL/Redis/`initdb`).
* Branch and PR accounting rechecked against GitHub: 50 branches (48 + `main` +
  convergence), 28 PRs (27 + #29); all 48 are named in §2.5/§2.1.

## 7. Behavior-level re-triage, 2026-11-08 (corrects §2.4)

§2.4 grouped several PRs as "covered by existing modules" on module-name
similarity. Checked by behavior and file presence on the convergence tree, that
was wrong. Dispositions (vocabulary: INTEGRATED / EQUIVALENT / NEEDS_PORT /
NEEDS_REPAIR / SUPERSEDED / PRESERVED_PENDING):

| PR | Capability | Disposition | Evidence |
|---|---|---|---|
| #23 | Selected Space model drives default mission roles; per-step provenance | **INTEGRATED** (`bbc37e4f`) | main hardcoded `"openai"`; `mission-plan.ts`, `mission-fleet.test.ts` (4) + `mission-plan.test.ts` (3) pass; provenance shown in `SpacesWorkbench.tsx` |
| #24 | Fail closed when the configured fleet cannot be read | **INTEGRATED** (`bbc37e4f`) | main swallowed the error into an empty fleet; strict `listAgentsForMission`; test asserts zero provider calls and no mission row. Real-PostgreSQL variant of the PR's test not run (no database here) |
| #20 | Mission evidence (`mission-evidence.ts`), workshop pop-out | **NEEDS_PORT** | `mission-evidence` absent from the tree |
| #21 | `mission-memory` (workspace-contained memory) | **NEEDS_PORT** | absent |
| #21, #22 | Arcade source workshop, `gameplay-contract`, `source-2048`, `source-rule-validation`, `/api/arcade/source`, `ArcadeSourceWorkshop` | **NEEDS_PORT** | none present |
| #19 | Failed-draft retention (`attempts`), stricter input/visual gate | **NEEDS_PORT** (gate itself exists; see HANDOFF) | `attempts` absent |
| #25, #26 | Integrated Arcade+Spaces candidate / Windows-ready candidate | **PARTIAL** | #26 stack recovered (§2.1); #25's Arcade/Spaces content is the NEEDS_PORT rows above |
| #15 | Waveyard coherence work (507 files) | **PRESERVED_PENDING** | needs a per-capability behavioral comparison against the current Waveyard; not yet done |
| #14, #16, #3, #5 | Deep-engine provisioning, memory ownership, A7 engine/retry | **#14: recovered via port/26 provision stack; #16, #3, #5: unverified** | needs comparison |
| #1 | Studio multimodal (WanGP/ComfyUI) | **PRESERVED_PENDING** | not compared |
