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

## Profile preparation controls

Native Workshop profiles now expose **BepInEx 5 · profile preparation**:
inspection, owner-approved ZIP selection, repair, and prior-core restoration.
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
- The disk reserve is checked before preparation.
- Configuration, cache, logs, plugins and ordinary game saves are not restored
  as part of core repair or rollback.
- A bounded history retains at most four previous core preparations.
- Failed preparation retains the previous authoritative state; completed
  publication does not depend on successful cleanup of obsolete files.
- A failed/interrupted preparation lock is reported rather than silently
  removed while another process might own it.

Preparation is **not activation**. Ordinary Workshop Play does not use this
companion loader yet. The panel says so, and its responses always retain
`canLaunch: false` and `gameplayVerified: false`. Plugin intake, permission and
dependency review, native Doorstop launch wiring, and actual modded-game
evidence remain within this unfinished task. Generic file overlays still do
not gain executable-DLL/plugin permissions.
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
without the relevant notices and permission assessment. The Windows game ZIP
has not been downloaded. Do not register either game as verified BepInEx support.

## Verification and remaining execution limitation

Both real pinned BepInEx archives have passed preparation tests: their actual
native proxies match Windows/Linux x64 respectively, core files are present,
and temporary staging/snapshot files are removed. These tests execute only
trusted Node ZIP/hash/parser code, not BepInEx or game code. Real-archive tests
explicitly skip when the ignored upstream downloads are absent.

The current host still has no admitted native-game execution pathway, and the
previous private-proc sandbox check failed. No uncontained Unity game was run
as a workaround. GitHub CI dispatch credentials were withheld, so there is no
external-runner gameplay result either. This blocks the task's required real
plugin/gameplay acceptance here; it does **not** mean the remaining loader,
profile and UI implementation work is finished.

The pinned BepInEx preloader source derives its BepInEx root from the actual
preloader assembly location, and `Paths.cs` places config/cache/plugins under
that root. A naive DLL copy into the current read-only Workshop generation
would therefore not provide writable config/cache/log behavior. The dedicated
adapter must account for this without modifying the immutable base, weakening
the game sandbox, or redirecting one profile into another profile's storage:

https://github.com/BepInEx/BepInEx/blob/v5.4.23.2/BepInEx.Preloader/Entrypoint.cs

https://github.com/BepInEx/BepInEx/blob/v5.4.23.2/BepInEx/Paths.cs

## Next implementation and acceptance

1. Assess the actual fixture archive and its notices; pin exact bytes, entry,
   Mono/Unity version and supported host. Use an owner-authorized build if the
   published payload cannot be redistributed. Linux-native assessment does not
   need Wine, but Arena's Linux game execution service is still absent.
2. Add a dedicated staged loader adapter. Do not relax generic DLL replacement
   rules. Keep the base installation untouched and separate writable loader
   config/log/cache paths from immutable loader/plugin payloads.
3. Import existing third-party plugin DLLs without rewriting them. Read their
   assembly metadata as data, check BepInEx dependencies/version constraints,
   hash and review native-capable permissions, and reject unsupported layouts.
4. Wire the adapter through existing Workshop review/commit/profile lifecycle
   and expose compatibility, versions, logs and failure recovery in its UI.
5. Use a real observable plugin (for example, a clearly labeled in-game HUD
   change) through actual BepInEx startup. A fake loader log is not evidence.
6. Prove two profiles with different plugin/config states, enable/disable,
   ordinary save restoration, failed update preservation, repair and exact
   known-good content rollback without rewinding current saves.

MelonLoader, IL2CPP and Unreal remain unverified, separate integrations.
