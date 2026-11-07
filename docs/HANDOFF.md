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
   branches hold work and evidence (see ledger).
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

## Priorities (in order)

1. **Land PR #28** (mashup fail-closed + Windows CI repairs) once Windows
   packaging and Waveyard browser acceptance are green.
2. **Port PR #26's Windows hardening** onto the pnpm workspace (it is on the old
   Next.js/npm layout, so it cannot merge directly). Owner confirmed it is
   important work. Port in slices on separate branches, each with tests:
   `fs-replace`, `artifact-reclamation`, `spaces/command-process`,
   `games/runtime-validation`, Waveyard `provision-store`/`provision-runtime`,
   the `seed`, `seed-http`, `ffmpeg`, `audio` fixes, then the export-publication,
   publication-integrity, session-live and mission-recovery tests, and finally
   the Windows acceptance workflow and readiness record. 15 of its source files
   do not exist on the current line and 11 differ; none are identical.
3. **Fair review of every branch and PR for lost work** (owner requirement, all
   41 branches and 43 PR refs, not only #26): for each, list unique commits
   against `main`, classify by capability, and record the result in the ledger
   below. Nothing is declared redundant without checking its diff.
4. **Protect `main`**: no branch protection or rulesets exist. Require CI and
   review before merge.
5. **Triage PR #27** (labelled test-only but changes Waveyard production logic and
   removes `hasReliableLiveStemTempoEvidence` / `hasReliableLiveStemBeatEvidence`
   still imported elsewhere). Do not merge as-is.
6. **Capability reconciliation** of PRs #1–#26 and historical branches against
   `main`: classify each capability as present+verified, present-unverified,
   superseded, missing, conflicting, or preserved-pending. Recover what is missing.
7. **Prove the whole app**: shared identity/projects/storage across rooms,
   persistence, restart recovery, real provider execution, Windows install.

## Current state

- `main` = `33c876a` (5 Nov 2026): Waveyard recovery, waveform integrity,
  automatic remix, analysis provenance, cross-tab stem recovery.
- **PR #28** `fix/mashup-bed-fail-closed-windows-tests` (based on
  `arena/84676e63-arena-os-canonical` @ `d105b18`, 5 commits ahead of `main`):
  - mashup render returns 422 on existing invalid stems (original-file fallback
    only when no separation exists);
  - Windows npm-cache and ONNX-DLL-lock test fixes (desktop tests pass on Windows CI);
  - Windows CI/build repairs that were already broken on `main`: MSVC header
    order and `winrt/Windows.Foundation.h` in `waveyard-capture-host.cpp`, runner
    MSYS2 at `C:\msys64`, win32-x64 native binaries un-pruned in
    `pnpm-workspace.yaml`, FFmpeg re-pinned to immutable
    `autobuild-2026-11-06-12-50`, embedded-postgres root resolved via its entry.
  - CI status: Windows desktop tests pass; both installers build; the installed app now starts and early smoke checks pass. Fixes found via the smoke check: PostgreSQL started via `pg_ctl` (admin token), `node_modules` copied in `afterPack`, restored clusters get their empty runtime dirs back. See the PR for the latest run. Waveyard browser timing check not confirmed green.

## Not verified (do not claim otherwise)

Real Demucs inference on Windows, GPU model provisioning, audible playback via
hardware, GUI mixer interaction, human-driven Arcade/Spaces flows on Windows,
code signing, auto-update. Hosted-runner results are not a substitute for the
owner's Windows 11 machine.

## Branch and PR ledger

Status key: **keep** (preserve, do not delete) · **recover** (has unique work to
bring into `main`) · **triage** · **likely redundant** (verify first).

| Ref | Notes | Status |
| --- | --- | --- |
| `main` | canonical, unprotected | keep |
| PR #28 | active fix PR (above) | active |
| PR #27 | mislabelled; breaks exports | triage, do not merge |
| PR #26 `arena/windows-ready-integration-2026-10-22` | npm/Electron-era convergence, 198 ahead / 480 behind main; 56 files of Windows hardening; six Windows jobs passed (1649 tests, 0 fail); evidence is for the old layout | **recover**: port by capability (Priority 2) |
| PR #25 Arcade+Spaces integration; PR #15 foundation (`04705ab`); PRs #19–24 Spaces/Arcade | stacked on old foundation, 480 behind | recover by capability |
| PR #1 original Studio; PR #10; PR #14 deep-engine provisioning | old, not mergeable | triage |
| PR #5 | 0 ahead / 508 behind | likely redundant |
| `benchmark/waveyard-*` (5 branches) | no PRs; benchmarking history | keep |
| `arena/208e8a9c…` | same commit as the Windows-ready branch | keep |
| other `arena/*`, `product/*`, `fix/*`, `replit/*` | see `docs/arena-baseline-backlog-reconciliation.md` | keep |

The 21 Oct 2026 convergence ledger (PRs #1–#25) lives on the PR #26 branch.
Backup of all refs: mirror clone and `git bundle` of
`imlochie/arena-os-canonical` (owner's machine).

## Handoff checklist for each session

- Read this file, `README.md`, and open PR descriptions/CI first.
- Do one focused task; keep the diff matching the description.
- Run the narrowest relevant tests plus `pnpm run typecheck`.
- Update "Current state", "Priorities" and the ledger before finishing.
