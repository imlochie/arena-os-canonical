# BepInEx integration: active work, not verified game support

## Scope and status

Work has moved to the existing game-specific mod-loader objective. The Wine
execution task is unfinished and is not a prerequisite for this work.
No real game/plugin has run through BepInEx in Arena yet.

Implemented so far:

- A bounded executable-header and Unity-layout assessment.
- Bounded Unity-version extraction from the selected game's serialized metadata.
- Immutable BepInEx 5.4.23.2 Windows/Linux x64 archive references with measured
  SHA-256 and byte counts in `desktop/arcade/bepinex.mjs`.
- `NativeModWorkshop.assessLoader` verifies the managed package and reads at
  most 64 KiB of its selected executable; it never loads game or plugin code.
- The owner-window-checked Workshop IPC exposes the read-only `assess-loader`
  operation. It makes no installed/working claim.
- `stageBepInExDistribution` verifies exact upstream archive bytes and safely
  prepares a fresh loader directory. It rejects preexisting destinations,
  links, unsafe paths, unexpected layout, oversized/encrypted entries and proxy
  architecture mismatches. No installer script or DLL is executed.

## Native plugin workflow

Native Workshop profiles expose **BepInEx 5 · native plugins**:
inspection, an owner-approved official pinned download or offline ZIP selection,
core repair/restoration, DLL intake, dependency review, enable/disable,
plugin repair/restoration, and a dedicated Windows launch action.
The main-process file picker supplies the archive path; renderer requests
cannot choose an arbitrary local source path.

`BepInExProfiles` anchors companion state to an existing Workshop profile,
its exact base version, and its pinned host distribution. It does not create
a second set of game/save identities. Core runtime files go beneath that
profile's existing native save root, while protected source generations and
state remain outside the game's writable capability.

- Profiles sharing base saves are deliberately not admitted yet.
- Any active native game prevents mutations.
- Hash and ordinary-file checks catch tampering; links/special files are
  refused even during repair.
- Disk reserve and managed-storage budget are checked before allocation.
- Configuration, cache, logs, plugins and ordinary game saves are not restored
  as part of core repair or rollback.
- A bounded history retains at most four previous core preparations.
- Failed preparation retains the previous authoritative state; completed
  publication does not depend on successful cleanup of obsolete files.
- A failed/interrupted preparation lock is reported rather than silently
  removed while another process might own it.

Preparation is **not activation**. Ordinary Workshop Play uses only reviewed
file overlays; **Launch with BepInEx** is the dedicated plugin path. `canLaunch`
means an attempt is available, not compatibility proof. Every response retains
`gameplayVerified: false`. Generic overlays still cannot introduce plugin DLLs.

Original managed DLLs are read as bounded PE/CLI metadata, never loaded in the
main process. Real BepInEx attributes supply GUIDs, versions, dependencies,
conflicts and process restrictions. Imports require owner authorization and
recorded license/use terms. New imports start disabled. Missing/old required
dependencies, duplicate enabled GUIDs, cycles, conflicts, wrong processes and
known other-loader/backend references fail closed. Raw managed plugin/support
DLLs are supported; asset ZIPs, native libraries, install hooks and preloader
patchers are not.

Protected sources and bounded plugin history remain outside the game's
writable capability. Only enabled copies enter its plugins directory.
Expected revisions reject stale edits. Repair/rollback preserve config/saves.

The launch adapter creates a separate read-only game copy from the immutable
base and reviewed overlays. It adds the pinned Windows Doorstop proxy and
configuration targeting the actual private profile's preloader location.
Execution requires the existing Windows host's containment probe; no
uncontained fallback exists. Short cache paths reduce Windows path growth;
full hashes still verify every file. Core repair clears derived launch caches
under the profile lock. Only the newest derived game copy per profile is kept.

The panel exposes launch/stop, failures and loader logs. Active-run polling is
lightweight, not repeated game hashing; one full inspection after exit
restores edit/launch availability and reads final logs.
- Architecture mismatch, absent Mono layout, another executable's data,
  IL2CPP/mixed layouts, and existing loader/proxy conflicts fail preflight.
  Unrecognized layouts are not universally unsupported; they need another
  explicitly assessed pathway.

Even a matching layout returns `canInstall: false` and
`gameplayVerified: false`. Header/layout evidence is not a managed-runtime
compatibility test. The existing generic plugin/DLL refusal stays in place.

## Measured loader archives

Fetched from the official BepInEx GitHub release `v5.4.23.2`, inspected as ZIP
data only, never executed:

| Host | Archive size | SHA-256 |
| --- | ---: | --- |
| Windows x64 | 637157 | `f752ce4e838f4c305b9da1404b6745f2cff23b8bfd494f79f0c84d0a01f59b46` |
| Linux x64 | 640773 | `ddc446143a0a277ed92eb7a1f5bf794ff4fdd0023bddc0491f85eafd1898225b` |

The Windows archive includes `winhttp.dll`, `doorstop_config.ini` and
`BepInEx/core`; Linux includes `libdoorstop.so`, `run_bepinex.sh` and the core
assemblies. These are executable native/managed payloads, not ordinary asset
overlays. Their dependency licenses/redistribution notices still need to be
collected before creating a redistributable Arena package.

Official installation reference:
https://docs.bepinex.dev/v5.4.21/articles/user_guide/installation/index.html

The reference describes BepInEx 5 Mono installation and first-run config/log
generation; it does not establish compatibility for every Unity version or
the selected game. Newer release-specific configuration must be checked against
the actual pinned archive, not assumed from the older documentation.

## Lawful fixture candidate

- Repository: https://github.com/Jonek2208/Open-Ski-Jumping
- Repository LICENSE: MIT, copyright 2023 Jonatan Hrynko.
- Published prerelease: `v0.5.0a18`.
- Linux asset: `OpenSJ_0.5.0a18_linux.zip`, 114892004 bytes.
- Windows x64 asset: `OpenSkiJumping_v0.5.0a18_64.zip`, 97213668 bytes.

The release is a **prerelease**; GitHub's `/releases/latest` returns 404.
This is not evidence that the repository has no downloadable releases.

The Linux archive has subsequently been downloaded from that exact upstream
release and inspected as ZIP data, without running its executable:

- Archive SHA-256:
  `f6d0355533b1b71ac0cf06619a1bd78d4f7d0de703b73f10c23242a63c0f69a4`.
- 267 ZIP entries (including directories).
- Entry: `0.5.0a18/OpenSkiJumping_v0.5.0a18.x86_64`, ELF x86-64.
- Unity metadata identifies **2020.3.2f1**.
- Managed game assembly:
  `0.5.0a18/OpenSkiJumping_v0.5.0a18_Data/Managed/Assembly-CSharp.dll`.
- Mono:
  `0.5.0a18/OpenSkiJumping_v0.5.0a18_Data/MonoBleedingEdge/x86_64/libmonobdwgc-2.0.so`.

The shipped data-local Mono layout was missing from the initial preflight.
It is now recognized and regression-covered. The actual archive produces
`candidate: true`, `canInstall: false`, `gameplayVerified: false`. This is
executable-header and package-layout evidence, not an executed managed-runtime
check. The bounded headers, file inventory and assessment are retained under
ignored `generated-artifacts/bepinex-research/`, not bundled in the app.

No license/notice-named files were found in this ZIP's inventory scan.
Its source repository's MIT license does not grant blanket redistribution
rights to Unity's runtime or all third-party assets. Keep this as an upstream
personal test download; do not add the binary to Arena distribution/catalog
without the relevant notices and permission assessment.

The actual Windows archive was also inspected as data:

- Asset `OpenSkiJumping_v0.5.0a18_64.zip`, 97213668 bytes.
- SHA-256 `2c2f389680af19ee63af42b029c6670f04ab92c8eef08a386c7533cbca0d77bb`.
- Entry `OpenSkiJumping_v0.5.0a18_64/Open Ski Jumping.exe`.
- 249 files; actual x64 header, matching Mono layout, Unity `2020.3.2f1`.
- Assessment `candidate: true`, `canInstall: false`, `gameplayVerified: false`.

This is Windows-specific package/header evidence, not Linux extrapolation or
execution. Neither game is registered as verified BepInEx support.

## Actual third-party plugin evidence

Official Configuration Manager v19.1:
https://github.com/BepInEx/BepInEx.ConfigurationManager/releases/tag/v19.1

- ZIP SHA-256 `dc10b1e7435dd3e0d32658b3f0f4230ddd71750164963b1095deca3bc3a98275`.
- Original `ConfigurationManager.dll`, 64000 bytes, SHA-256
  `143bb25e8f03ed8728224de0b72752de29c0962ff69d20ec685831ec7491b323`.
- Assembly `ConfigurationManager` version `19.1.0.0`.
- Plugin `com.bepis.bepinex.configurationmanager`, version `19.1`.
- The upstream archive includes GNU LGPL version 3 terms. This is a personal
  upstream test download, not a binary bundled into Arena.

Tests parse, import, enable/disable, repair and roll back these original DLL
bytes across two profiles without executing or rewriting them. This is
intake/state evidence, **not a plugin-loaded or visible-gameplay result**.

## Verification and remaining execution limitation

Both real pinned BepInEx archives have passed preparation tests: their actual
native proxies match Windows/Linux x64 respectively, core files are present,
and temporary staging/snapshot files are removed. These tests execute only
trusted Node ZIP/hash/parser code, not BepInEx or game code. Real-archive tests
explicitly skip when the ignored upstream downloads are absent.

This Linux workspace cannot execute the Windows LPAC/Job launch path, and the
previous Linux private-proc check failed. No uncontained game was run as a
workaround. No external-runner gameplay result has been obtained. Intake,
profile management, launch composition and UI wiring are implemented; real
plugin/gameplay acceptance remains blocked.

The pinned BepInEx preloader source derives its BepInEx root from the actual
preloader assembly location, and `Paths.cs` places config/cache/plugins under
that root. A naive DLL copy into the current read-only Workshop generation
would therefore not provide writable config/cache/log behavior. The implemented
adapter accounts for this without modifying the immutable base, weakening
the game sandbox, or redirecting one profile into another profile's storage:

https://github.com/BepInEx/BepInEx/blob/v5.4.23.2/BepInEx.Preloader/Entrypoint.cs

https://github.com/BepInEx/BepInEx/blob/v5.4.23.2/BepInEx/Paths.cs

## Remaining end-to-end acceptance

1. On an authorized Windows x64 host, install the exact upstream game through
   the managed-game path using the entry above. Confirm preflight and the real
   LPAC/Job containment probe. Its acquisition-to-launch UI path is not yet
   demonstrated for this specific fixture.
2. Create private profiles A and B, prepare the pinned core, and import the
   actual Configuration Manager DLL with its license recorded. Enable it only
   in A. Launch A using **Launch with BepInEx**, not ordinary Play.
3. Retain the genuine loader log identifying the expected plugin GUID/version,
   obtain its visible in-game interface/change, and confirm game input works.
   A marker program, process start, metadata parse or fake log is not proof.
4. Launch B and demonstrate independent plugin/config/save state; verify
   unchanged base hashes. Disable A's plugin and show the change disappears.
5. Exercise a legitimate plugin update, failed/incompatible update, repair and
   rollback without rewinding current saves. Same-pin core preparation is not
   a loader-version upgrade test.
6. Tamper with writable loader/plugin copies and a derived launch cache;
   require refusal before execution and recover through repair controls.
   Verify crash/log visibility, stop/process-tree termination and relaunch.

Until this passes, the result is **implemented but native-gameplay
unverified**, not a completed real-game demonstration. Linux archive
preparation does not implement or prove Linux modded-game execution.

MelonLoader, IL2CPP and Unreal remain unverified, separate integrations.
