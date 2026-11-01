# BepInEx integration: active work, not verified game support

## Scope and status

Work has moved to the existing game-specific mod-loader objective. The Wine
execution task is unfinished and is not a prerequisite for this work.
No real game/plugin has run through BepInEx in Arena yet.

Implemented so far:

- A bounded executable-header and Unity-layout assessment.
- Immutable BepInEx 5.4.23.2 Windows/Linux x64 archive references with measured
  SHA-256 and byte counts in `desktop/arcade/bepinex.mjs`.
- `NativeModWorkshop.assessLoader` verifies the managed package and reads at
  most 64 KiB of its selected executable; it never loads game or plugin code.
- The owner-window-checked Workshop IPC exposes the read-only `assess-loader`
  operation. There is no install button or installed/working claim.
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

Only public repository license, project settings and release metadata were
inspected. The game archives have not been downloaded or hashed. The shipped
backend, Unity version, actual managed assemblies, bundled asset notices and
binary redistribution terms have not been verified. MIT repository metadata
must not be generalized into a license for Unity's proprietary runtime.
Do not register this as a working game/loader fixture until those checks pass.

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
