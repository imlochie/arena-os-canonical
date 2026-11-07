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
2. **Protect `main`**: no branch protection or rulesets exist. Require CI and
   review before merge.
3. **Triage PR #27** (labelled test-only but changes Waveyard production logic and
   removes `hasReliableLiveStemTempoEvidence` / `hasReliableLiveStemBeatEvidence`
   still imported elsewhere). Do not merge as-is.
4. **Capability reconciliation** of PRs #1–#26 and historical branches against
   `main`: classify each capability as present+verified, present-unverified,
   superseded, missing, conflicting, or preserved-pending. Recover what is missing.
5. **Prove the whole app**: shared identity/projects/storage across rooms,
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
  - CI status: Windows desktop tests pass; both installers build; "Install and check packaged app" FAILS at `installed_app_starts` (smoke script swallows the error, then the step hangs). Undiagnosed next task: temporarily print the caught error in `desktop/windows-package-smoke.mjs` on a probe branch. Waveyard browser timing check not confirmed green.

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
| PR #26 `arena/windows-ready-integration-2026-10-22` | npm/Electron-era convergence, 198 ahead / 480 behind, six Windows jobs passed at `2fdacae`; evidence stale (4 product commits after the recorded one) | recover Windows work by capability |
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
