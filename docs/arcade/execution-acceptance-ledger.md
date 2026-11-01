# Arcade execution foundation: baseline and acceptance ledger

Baseline inspected: 2026-11-01.

The bounded browser runtime/manifest foundation is implemented. This is not a Windows readiness declaration or a universal game-compatibility claim. The detailed source map and full directive target matrix are in [the runtime foundation audit](runtime-foundation-audit.md).

## Scope and evidence rules

The governing directive is `attached_assets/Pasted-I-think-Arcade-needs-a-much-bigger-ambition-Arcade-shou_1793462458411.txt`.

- **Implemented** means the named, bounded capability has a wired implementation. It does not imply every game in a family works.
- **Partial** means a pathway exists but a requested lifecycle capability or execution proof is missing.
- **Planned** means no corresponding execution pathway was identified in the audited Arcade TypeScript paths. This is not a claim that every unrelated desktop subsystem has been audited.
- Source evidence, controlled-fixture execution, public-repository downloads, real model inference, and target-host gameplay are different evidence categories.
- A runtime being configured or downloaded is not proof that a particular game launched or played.

## Current capability matrix

| Capability | Current status | Source evidence | Execution evidence and limits |
|---|---|---|---|
| Authorized offline HTML/ZIP game import | Implemented, bounded | `artifacts/arenaforge/src/components/ImportedGameWorkspace.tsx`: authorization, archive asset inlining, size/file limits, existing sandbox player | Original controlled game imported, clicked, reloaded, exported, reimported, and clicked again by `scripts/arcade-repository-import.mjs`. Not proof for arbitrary HTML games. |
| Public GitHub repository/release-tag source acquisition | Implemented, bounded | `artifacts/api-server/src/imported/arcade/repository-source.ts`; inspect/acquire route registrations; `RepositoryGameImport.tsx` | Real GitHub acquisition of `gabrielecirulli/2048`, commit `478b6ec346e3787f589e4af751378d06ded4cbbc`: 27 pinned files, 586714 bytes, MIT. **Download verification only; that public game was not gameplay-verified.** Browser integration uses an original fixture instead. |
| Source and repository-license retention | Implemented for the main repository notice | `importedRepositoryAttribution.ts`; import, export and revision application in `ImportedGameWorkspace.tsx` | Focused tests cover round trips, edit retention, malformed/conflicting records and unrelated scripts. Browser export/reimport/reload retains the fixture's origin and license. Additional dependency-specific notices require further work. File-declared provenance is not fresh GitHub verification. |
| Prompt-created games | Partial: real provider paths exist; runtime success is not established here | `ArcadeForge.tsx`, `lib/arena/src/lib/games/forge-ai.ts`; existing forge routes | No real model call was performed in this audit. Neither starter games nor mocked responses count as generation proof. |
| Prompt edits of imported HTML | Partial: current-source handoff and safety checks exist | `onReviseSource`, embedded-media masking/restoration and `applyHtmlRevision` in `ImportedGameWorkspace.tsx`; imported revise route | Attribution retention is unit-tested. A complete real-model edit/play/restart journey was not run here. |
| Imported-game revision history | Bounded accepted history plus pending undo | `importedGameRevision.ts` and `ImportedGameWorkspace.tsx`: up to five previous copies / 18 MiB source data per game, instruction/time/size labels, any-copy restore, reversible source swaps, commit-before-activation | Ten focused unit checks and eight Chromium recovery checks cover legacy records, count/byte retention, keep/reload, older-copy restore/reverse restore, stable identity and progress, pending undo, cancellation, unsafe/provider responses, and failed apply/keep/restore writes. Model responses are fixtures, not actual inference. Safari and native Windows are not established by this evidence. |
| Imported source comparison | Local read-only comparison, pending or kept source | `ImportedGameSourceComparison.tsx` and `importedGameSourceComparison.ts`: added/removed lines, numbered context, exact shared embedded-data labels, bounded work/output and explicit excerpt warnings | Nine unit checks cover separate edits, markup as text, changed media, line endings and large inputs. The focused Chromium workflow additionally verifies zero requests during comparison, unchanged pending source/history/progress, no player reload, return focus to the same game, Escape closing after Keep, and a 390px viewport before Undo. No additional model call or server comparison route. |
| Imported HTML progress isolation | Verified across separate game identities | `arcadeGameSave.ts` checks the active source window and game ID; `ImportedGameWorkspace.tsx` holds bootstrap documents stable during ordinary save-indicator updates | Four focused Chromium scenarios import identical source under identical filenames with the same storage key; prove distinct progress through switching, page reloads, revision/keep/rollback, forged cross-ID and wrong-window messages, and game/host removal and clear controls. First-save and game-originated clear preserve live DOM markers. Revision input excludes both saves. Inference is mocked; native Windows, storage-failure warnings and created-game player behavior are not established by this check. |
| Imported HTML progress portability | Local export, preview and confirmed restore | `ImportedGameProgressBackup.tsx`, `arcadeGameProgressBackup.ts` and `arcadeGameSave.ts`: versioned bounded JSON, per-import identity, source fingerprint for opt-in copy migration, atomic progress-only write and explicit player reload | Eight unit checks cover schemas, bounds, reserved keys, changed source, copy eligibility and failed/stale writes. The extended Chromium isolation flow adds real download/upload, cancellation, malformed/mismatched/oversized rejection, quota retry, stale-preview refusal, source/history preservation and fresh-context re-import/restore/reload at mobile width. This does not prove native Safari Files behavior or protection from another already-open stale game tab. |
| CHIP-8 / Super-CHIP portable snapshots | Local export and confirmed same-ROM/profile restoration | `Chip8ProgressBackup.tsx`, `chip8ProgressBackup.ts` and `Chip8Player.tsx`: bounded versioned files, exact original-ROM fingerprint, existing interpreter validators and storage namespaces, paused preview, retired old runtime before effect cleanup | Six unit checks cover classic random continuation, detached state, profile/ROM/version rejection, extended display/RPL/halt and waiting-key continuation. Twelve focused Chromium scenarios retain the nine existing emulator checks and add actual file download/upload, paused review/cancel, bad-file rejection, quota-safe retry, restored framebuffer/RPL persistence and transfer of an actual download into a fresh mobile-width browser context. Snapshots include emulated program memory and remain local. Native Safari file handling and cross-tab stale writers are not established. |
| NES through JSNES | Implemented pathway, compatibility-limited | `ImportedGameWorkspace.tsx`: iNES validation, 1 MB import limit, mapper checks, controls, battery RAM and save-state calls | Existing regression script coverage is source evidence only in this audit. Actual visible-progress restoration must be demonstrated separately. |
| Classic CHIP-8 | Implemented pathway, format-limited | `ImportedGameWorkspace.tsx` routes to `Chip8Player`; classic program bound is `0x1000 - 0x200` bytes | Subsequent focused check: an original classic fixture responds to keyboard input, retains its version-1 progress through Super-CHIP use and reload, and returns to the same 64×32 pixels. Not a general claim for all classic titles. |
| Super-CHIP (modern profile) | Implemented, explicitly separate dialect | `chip8Runtime.ts`, `Chip8Player.tsx`, `ImportedGameWorkspace.tsx`: .sc8/.sch8 or explicit .ch8/.c8 opt-in; 4 KB memory; high/low resolution, scrolling, 16×16 sprites, large hex font, eight RPL flags and normal exit | Subsequent focused implementation check: 12 runtime tests and `node scripts/arena-smoke.mjs --chip8-only` pass with original generated classic/Super-CHIP programs. Observed actual canvas output, on-screen/keyboard input, scrolling, mode changes, save/reload, exit/reload, confirmed restart retaining RPL flags, legacy saves and explicit ambiguous-file selection. No Windows or third-party-game compatibility claim. |
| Browser EmulatorJS integrations | Implemented pathway, host/core/game-dependent | `arcadeEmulatorRuntime.ts`, `EmulatorJsPlayer.tsx`: version 4.2.3; GB/GBC, GBA, SNES, Mega Drive, Master System, Game Gear and N64 selectors | Registry entries are not per-game compatibility proof. Current data URL is the versioned EmulatorJS CDN; offline provisioning and target-host behavior require verification. |
| Browser-local shelf persistence | Implemented, with explicit failure handling | `importedGameStorage.ts`: IndexedDB, transactional stale-write checks, storage revisions and change notifications; `ImportedGameWorkspace.tsx`: committed baseline and retry handling | Fixture source/provenance survive reload. Do not infer all save formats, storage-quota failures, cross-device portability or private browsing from that test. |
| Versioned cross-runtime game manifest | Implemented bounded foundation | `arcadeManifest.ts`, `arcadeManifestStorage.ts`, `useArcadeManagement.ts`, `ArcadeGameManagement.tsx` | Separate versioned metadata retains game IDs, source/ROMs, history and save aliases. Atomic write/abort, unknown schema, explicit rebuild/recovery export and exact-context evidence checks pass. No native installation claim. |
| Independently managed runtime adapters | Implemented for existing browser players | `arcadeRuntimeAdapters.ts`: open registry, identification, provisioning, host/architecture/capability assessment, concrete launch/session, cleanup and recovery contracts | HTML, JSNES, CHIP-8/Super-CHIP and EmulatorJS players use adapters. External assets remain delegated, not fake-installed. New runtime registration still needs an actual bound driver and per-game execution evidence. |
| Managed desktop installation and native execution | Planned downstream work | Existing isolated desktop execution plan | No execution claim from this audit. The broader desktop host still needs its own source/security investigation. |
| Reproducible repository builds and native releases | Planned downstream work | Existing repository acquisition/build plan | Current GitHub importer intentionally does not run install or build scripts. Successful source acquisition is not a compiled, installed or playable game. |
| DOSBox, ScummVM, native Libretro/RetroArch, MAME and standalone emulators | Planned integration targets | Existing classic-runtime plan; no direct Arcade TypeScript launch wiring identified in this audit | Browser emulator cores do not prove a managed native frontend/Libretro lifecycle. Each adapter needs separate actual execution evidence. |
| Wine/Proton compatibility-layer execution | Planned downstream work | Existing compatibility-layer plan | No host provision, game launch, controls, audio or save/restart proof established here. |
| Mod Workshop: patches, independent profiles, dependency/load order and rollback | Planned downstream work | Existing Mod Workshop plan | HTML source revision and a pending undo field are not a replacement for this subsystem. |
| Existing game-specific mod loaders | Planned downstream work | Existing loader plan, initially targeting Unity Mono/BepInEx | No loader installation or modified-game execution proved here. Do not generalize Mono evidence to IL2CPP or other engines. |
| Governed agent-assisted mod development | Planned downstream work | Existing agent/mod-development plan | A prompt editor is not proof of governed source investigation, build, installation, launch, testing or rollback. |

## Existing paths to preserve

1. **Prompt creation:** Arcade room → selected connected code-writing model → source/safety and isolated startup checks → game/draft distinction → existing player and save identity. A quick starter is an example, not a model fallback.
2. **File import:** explicit permission → HTML or ZIP/ROM/program validation → local game record → existing browser runtime → existing save mechanism.
3. **Repository import:** approved GitHub link → immutable revision, recognized repository license and bounded manifest → explicit review → pinned file download/hash checks → existing offline ZIP importer → browser-local shelf. Unsupported layouts remain explicit refusals.
4. **Source edit:** selected game's current HTML → mask bundled media and remove only recognized inert attribution from model input → explicit selected-model request → restore media → source/safety checks → pending revision with original source retained.
5. **Persistence:** imported records remain in browser-owned IndexedDB; battery/save-state/progress mechanisms retain their existing game identity. Do not move imported ROM bytes or private source into the shared catalog.
6. **Portable source:** explicit HTML download → import through the same authorization/safety path → restore declared provenance → local shelf. This export does **not** include gameplay save/progress data.

## Queue dependency checkpoint

The imported-edit/restart, emulator input/refusal, Super-CHIP, change review and bounded source-history prerequisites have been integrated and checked. This foundation extends them rather than replacing them. The queued desktop-execution, reproducible repository/build and Mod Workshop layers remain downstream, followed by game-specific mod loaders, verified compatibility-layer execution, classic PC/external runtimes and governed mod development. Those are still implementation work, not completed capabilities.

## Foundation verification

- `pnpm --filter @workspace/arenaforge run typecheck` and `git diff --check`: passed.
- Six `arcadeManifest.test.ts` checks: schema, bounded metadata/no source bytes, aliases/provenance, independent evidence contexts, required capabilities, open registry and actual sandbox/CHIP-8 construction.
- `node scripts/arena-smoke.mjs --arcade-manifest-only`: five browser checks cover legacy migration without source/history/save changes, player continuity, honest observation export, unknown runtime/cancel/rebuild/recovery, unsupported schema, atomic quota/abort rollback, created-game aliases/first-save continuity and 390px layout.
- Existing `--progress-backup-only`, `--chip8-backup-only` and `--revision-rollback-only` suites: passed. Models are controlled responses, not actual inference.
- `pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/arcade-repository-import.mjs"`: controlled repository/ZIP/assets/license/source export and refusal paths passed. Use the TypeScript loader; plain Node strip-only mode cannot execute the repository helper's parameter properties.
- `node scripts/arcade-shelf-persistence.mjs`: passed through real Chromium profile restart, original NES input/save restoration, exact large-ROM persistence, per-record stale conflicts, source-store quota/delete/clone failures and cross-tab refresh. Its source-shelf instrumentation is scoped to that database so independent metadata operations do not masquerade as game writes.
- EmulatorJS configuration remains pinned; save/load defaults remain runtime-owned. Load-error/timeout diagnostics and explicit retry do not install save hooks. The large-ROM fixture intercepts its loader: **storage-only, not new core gameplay evidence**.
- No real model inference, native Windows execution or native iOS/Safari pass is claimed. The 390px check is Chromium responsive layout, not an iPhone runtime test.

This audit does not remove those links, reassign jobs, or mark blocked work as running/completed. Re-read live task states before acting; this checkpoint can become stale.

Subsequent implementation update: the Super-CHIP prerequisite was explicitly assigned and implemented, with the focused evidence above. Classic CHIP-8 version-1 save keys and behavior remain in place; Super-CHIP has separate version-2 snapshots. The modern profile intentionally does not emulate original HP48 half-pixel scrolling/collision quirks, share RPL flags across unrelated games, implement XO-CHIP, or produce sound. The two revision prerequisites remain separate work. Final task/queue status comes from the live task records, not this document.

## Migration and adapter constraints

- Preserve existing game IDs, save-slot aliases, source/ROM bytes, ROM system identifiers, pending edits, and storage revision/CAS semantics.
- Reconcile incoming prerequisite changes before defining history migration. Do not flatten a new history back into one pending undo field.
- Use atomic, recoverable migrations. A failed write must leave the previous committed game and progress available; do not manufacture a new identity to bypass a conflict.
- Wrap existing HTML, JSNES, CHIP-8 and EmulatorJS players rather than replacing their working controls or persistence with a demonstration adapter.
- Model availability and game-runtime availability are separate concerns. A model's WebGPU status must not become a blanket game-runtime compatibility indicator.
- Runtime IDs must be extensible. Existing console IDs may be retained as legacy configuration, not treated as the universe of supported future engines.
- Keep host/runtime provisioning, a game's requirements, and game-specific compatibility evidence distinct.
- Runtime installation, permission grants, dependency resolution and uninstall/cleanup need explicit contracts. Do not silently execute third-party repository scripts in the API process.
- Keep optional runtimes separately provisioned rather than adding every engine/core to the base application bundle.
- Record downloaded, installed, built, startup-verified and gameplay-verified separately, with game version, runtime/version, host and evidence. Do not promote a successful download to playable status.

## Representative acceptance collection

| Required example | Current evidence | Evidence still required |
|---|---|---|
| Browser open-source game | Controlled original HTML fixture play/reload; separate public repository acquisition | Select a legally suitable real repository game and demonstrate its actual installation/import, controls, audio where applicable, persistence and recovery. |
| Source-built Godot game | None established | Reproducible build, isolated install, native launch, input/audio, saves, shutdown/recovery. |
| Source-built SDL or similar game | None established | Same full native lifecycle, with actual dependency resolution and logs. |
| DOS game | None established | Lawful fixture, actual DOS runtime, controls/audio and save/restart behavior. |
| Libretro-compatible game | No native workflow established | Actual managed adapter/core/game lifecycle; do not substitute a console name in a registry. |
| Standalone console emulator workflow | Browser pathways exist, not this acceptance case | Actual standalone executable provisioning, controls, saves, shutdown and cleanup. |
| Compatibility-layer game | None established | Exact host, layer/version, legally usable game and observed full lifecycle. |
| Working mod loader | None established | Game/version/framework-specific loader installation and observable mod behavior. |
| Multiple independent mod profiles | None established | Profile isolation, deterministic load order, correct saves/configuration boundaries and independent launch results. |
| Patched game with verified rollback | Source-level pending undo is not this acceptance case | Patch/base integrity, visible change, rollback to the original content and preserved unrelated data. |

## Reproducible checks already available

Run from the workspace root:

```sh
pnpm --filter @workspace/scripts exec tsx --test \
  "$PWD/artifacts/arenaforge/src/lib/importedGameRevision.test.ts" \
  "$PWD/artifacts/arenaforge/src/lib/importedGameSourceComparison.test.ts"
node scripts/arena-smoke.mjs --revision-rollback-only
node scripts/arena-smoke.mjs --progress-isolation-only
pnpm --filter @workspace/scripts exec tsx --test \
  "$PWD/artifacts/arenaforge/src/lib/arcadeGameProgressBackup.test.ts"
node scripts/arena-smoke.mjs --progress-backup-only
pnpm --filter @workspace/scripts exec tsx --test \
  "$PWD/artifacts/arenaforge/src/lib/chip8ProgressBackup.test.ts"
node scripts/arena-smoke.mjs --chip8-backup-only
pnpm --filter @workspace/scripts exec tsx --test \
  "$PWD/artifacts/arenaforge/src/lib/chip8Runtime.test.ts"
node scripts/arena-smoke.mjs --chip8-only
pnpm --filter @workspace/scripts exec tsx --test \
  "$PWD/artifacts/api-server/src/imported/arcade/repository-source.test.ts" \
  "$PWD/artifacts/arenaforge/src/lib/importedRepositoryAttribution.test.ts"
pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/arcade-repository-import.mjs"
pnpm --filter @workspace/arenaforge run typecheck
pnpm --filter @workspace/api-server run typecheck
```

Focused browser reports are generated at `generated-artifacts/arcade-repository-import/report.json` and `generated-artifacts/arcade-chip8/report.json`; both explicitly record `modelCallTested: false`. Existing broader scenarios live in `scripts/arena-smoke.mjs`; their presence is not evidence the full suite was rerun. The initial audit was documentation-only; subsequent Super-CHIP runtime/browser checks are recorded separately above. No Windows checks have been run for this work.
