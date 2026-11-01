# Arcade runtime foundation audit

Inspected against the universal Arcade directive on 2026-11-01. This is an
expansion of the existing room, not a replacement launcher or a universal
compatibility claim. Read the execution ledger for actual observed outcomes.

## Source-backed path map

| System | Existing source and flow | Foundation boundary / remaining limit |
|---|---|---|
| Creation | `ArcadeForge.tsx` → WebLLM or `/api/arcade/forge` → `games/forge-ai.ts` → selected `ai.generate` → validation/one repair → isolated startup → game or draft | No provider policy changed. Deterministic starters remain explicitly separate. No real model call was available for this foundation check. WebGPU belongs to browser AI, not these game runtimes. |
| Imported edits | `ImportedGameWorkspace.tsx` → permission, current HTML, media masking → `/api/arcade/import/revise` → `reviseImportedHtmlWithAI` → safety checks → pending/kept bounded history | No save bytes in model requests. Source revisions and undo are retained outside manifests, not flattened into a new game or preset. |
| File discovery/import | Existing HTML/ZIP, NES, CHIP-8/Super-CHIP and EmulatorJS inputs → existing size/header/dialect/asset checks → private IndexedDB | Manifest identification is not a new file-format permissiveness rule. Arbitrary native files still require downstream acquisition/execution. |
| Repository acquisition | `repository-source.ts`, inspect/acquire routes, `RepositoryGameImport.tsx`, attribution helpers | Pinned GitHub source, recognized main license, limits and hashes feed the existing ZIP importer. No build scripts, dependency installers or native binaries are run. |
| Browser execution | `arcadeRuntimeAdapters.ts` launches the existing restricted HTML document builder; NES constructor/ROM load; CHIP-8 interpreter; pinned EmulatorJS configuration | Typed adapter registry is open to new IDs/formats. Registering metadata alone does not bind a new executable/player or prove a game. Existing players own rendering/input scheduling. |
| Persistence | `importedGameStorage.ts`, `offlineGameStorage.ts`, `arcadeGameSave.ts`, `nesSaveStates.ts`, CHIP-8 local states, EmulatorJS defaults | Identities, source, revisions and save namespaces stay where they were. The manifest sidecar stores metadata only. HTML and CHIP-8 portable saves remain separate files. |
| Management | `arcadeManifest.ts`, `arcadeManifestStorage.ts`, `useArcadeManagement.ts`, `ArcadeGameManagement.tsx` | Versioned metadata, discovery, compatibility diagnostics, explicit observations, export and recoverable rebuild. This is not editable controller/mod settings or an installed desktop-runtime manager. |
| AI / agents / missions / tools | Existing model orchestration and REA static-analysis route; no Arcade acquisition/build/execute mission coordinator in the audited Arcade paths | REA requires explicit permission and sends HTML to Arena API; it is not a local emulator or an autonomous mod installer. General Arena missions/tools are not a verified game-development integration. |
| Security | API access/owner gates in Arcade routes; original imported-HTML and generated-code policies; bounded offline ZIP bundling and provenance checks | Imported code runs in an opaque-origin restricted iframe with no network; ROMs are interpreted data. EmulatorJS is trusted third-party runtime code in its existing same-origin iframe, a broader trust boundary retained to avoid breaking storage. No private imports or ROMs enter the public catalog. |

## Contract and migration decisions

- A manifest stores provenance/license, a content digest as installed version,
  runtime ID/version/profile, requirements, launch reference/arguments,
  permissions, existing save/configuration locations, baseline profile and
  version/history/evidence metadata. It never stores source, ROMs or save bytes.
- Profiles describe existing controls/audio/graphics and an empty mod list.
  They do **not** pretend that editable bindings or Mod Workshop are implemented.
- Manifests are lazily prepared when existing games are opened. A separate local
  IndexedDB sidecar uses ownership + original ID + content-version keys. Older
  tabs cannot overwrite a different source version's metadata. Existing source
  stores, ownership, aliases, pending edits and history remain authoritative.
- Metadata batch writes are atomic. A failure falls back to an in-memory
  descriptor for the already-known legacy player, with a warning; original
  games remain usable. Unknown schema data is not silently rewritten.
- Rebuild is explicit and confirmed; the previous metadata is retained and
  exportable in a recovery file. This does not reset a game or its progress.
- Required adapter capabilities cannot be removed by a manifest. Unknown,
  mismatched, unbound or wrong-version runtimes/profiles do not launch.
- Each concrete adapter declares identification, host/architecture,
  provisioning, launch/native session interfaces, input/audio/graphics,
  persistence/mod capabilities, diagnostics, cleanup and recovery ownership.
  HTML prepares the actual sandbox document; JSNES dynamically loads its
  installed module and ROM; CHIP-8 constructs the existing interpreter;
  EmulatorJS prepares the existing pinned runtime configuration.
- Downloaded, installed, built, startup and gameplay are independent evidence
  stages. Evidence is scoped to content version, host/browser identity,
  runtime/version and profile. Opening/saving a manifest does not verify startup.
  Explicit player observations are labeled `user-observation`, not automation.
  A saved browser game record is not a native installation.
- WebGPU, LLM downloads and model readiness never imply game-runtime support.

## Integration-target matrix

“Planned” below means no direct executor in the audited Arcade paths, not a
claim about unrelated software installed elsewhere in Arena.

| Requested target | Implementation status | Execution evidence / requirement |
|---|---|---|
| HTML5 / DOM / Canvas JavaScript | Implemented bounded adapter | Existing controlled imports, generated/offline games and revision tests; not arbitrary-web-app compatibility. |
| Browser WebAssembly games | Partial | EmulatorJS uses WASM; generic ZIP WASM/fetch/module dependencies are not automatically bundled by the offline importer. A suitable adapter/bundler is required. |
| JSNES standalone browser NES | Implemented bounded adapter | Original NROM/controller fixture; mapper/core coverage remains game-specific. Audio samples are currently discarded. |
| CHIP-8 and Super-CHIP homebrew | Implemented separate profiles | Original programs exercise rendering, controls, resolution, snapshots/reload, RPL and portable files. Sound-timer output is not audible yet. |
| EmulatorJS console families | Implemented delegated pathway | GB/GBC, GBA, SNES, Mega Drive, Master System, Game Gear and N64 use pinned 4.2.3 assets. First-load network/cache and per-game compatibility remain distinct. No new core execution proof is claimed from a config-unit check. |
| Native Windows / Linux / macOS | Planned downstream | Isolated installation/execution, permissions, architecture and actual host evidence required. Browser host is not a native executor. |
| Wine / Proton | Planned downstream | Compatibility layer provisioning, verified target binary, controls/audio and restart/save evidence required. |
| DOSBox | Planned downstream | DOS execution/filesystem and save/configuration adapter required. |
| ScummVM | Planned downstream | Supported engine/data identification and actual runtime provision required. |
| RetroArch / native Libretro | Planned downstream | Core/frontend lifecycle, installation, configuration and per-game evidence required; not inferred from a browser core. |
| MAME | Planned downstream | Runtime/version and authorized matching game data required. |
| Other standalone emulators / handhelds | Planned downstream | New adapter, dependencies/BIOS where applicable, trust boundary and explicit per-game evidence required. |
| Godot | Planned downstream | Browser export may fit existing bounded import; source-built/native project execution is not implemented. |
| Unity / Unreal / GameMaker | Planned downstream | A repository/release analyzer, reproducible build or compatible export and runtime driver are required. |
| SDL / Love2D / MonoGame / FNA | Planned downstream | Language/toolchain/OS dependencies and isolated build/run lifecycle are not supplied by the registry. |
| Homebrew/custom runtime | Extensible contract, execution varies | New IDs and identification can register without modifying a console enum; a real provision/launch driver still must be integrated. |
| IPS / BPS / UPS / xdelta, ROM hacks | Planned Mod Workshop | No patch application/integrity/rollback claim from HTML source edits. |
| BepInEx / MelonLoader / REFramework and game-specific loaders | Planned downstream | Actual loader installation and modded-game execution remain unverified. |
| Independent mod profiles, load/dependency/conflict order | Planned downstream | Manifest profile references are foundations, not an implemented mod manager. |
| AI-assisted mod development / governed missions | Partial source editing; broader integration planned | Current source editing is real wiring with a selected model; no verified mission-to-build-to-install-to-gameplay chain. |

## Directive acceptance examples

| Example | Acceptance boundary |
|---|---|
| Open-source browser game | Existing pinned 2048 acquisition proves download/license retention only; original offline fixture proves import/input/asset/reload path. Do not merge those into a public-game gameplay claim. |
| Source-built Godot and SDL/native games | Not run; downstream acquisition/build and desktop executors required. |
| DOS / Libretro / compatibility-layer game | Not run; required executor and host provision absent from this phase. |
| Standalone emulator workflow | Existing JSNES and CHIP-8 controlled programs; not proof of every ROM/mapper. |
| Working mod loader and independent mod profiles | Not run; downstream Mod Workshop and game-specific loader work. |
| Modified game with rollback | Existing HTML source edit/comparison/history flow, with controlled inference responses; not a native binary mod-loader result. |

The queued desktop execution, reproducible acquisition/build and Mod Workshop
phases remain the next work. No new native executor, additional core, public
ROM catalog, provider fallback or universal-compatibility claim is introduced.
