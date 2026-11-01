# Classic runtime integration and evidence

## What is wired

The native Arcade panel exposes exact runtime/core selections, explicit ScummVM
engine identification, OS-approved private data imports, runtime rebinding and
recipe diagnostics. The owning Electron main frame is required. Renderer requests
never supply filesystem paths, executable paths or arbitrary engine arguments.

| Adapter | Pinned distribution | Data / controls / progress |
|---|---|---|
| DOSBox Staging | 0.83.0 Windows x64 | Authorized DOS COM/EXE with an 8.3 entry path; keyboard/mapper/joystick settings. A per-profile writable C: working copy supports relative assets and in-folder saves; immutable originals remain on D:. No host-drive mounting after secure mode. Not Windows EXEs. |
| ScummVM | 2026.4.0 Windows x64 | Explicit supported game identifier and authorized matching game data. Mouse/keyboard and upstream gamepad settings; separate save directory and profile config. Engine-specific data requirements still apply. |
| RetroArch + Gambatte | RetroArch 1.22.2; separate API-1 core compiled from `77f2567d718b8973d02caa2daa8dce4953faf811` | GB/GBC only, not arbitrary cores/MAME. Independent SRAM, exact-pair state directories and core options. RGUI/software GDI defaults avoid requiring browser WebGPU or heavyweight menu assets. XInput settings are editable, not a claim every controller has passed. |
| SameBoy standalone SDL | 1.0.4 Windows x64 | One authorized GB/GBC ROM copied into the private profile; adjacent battery/state files survive ROM restoration. `--nogl`; upstream keyboard/controller UI. Includes its own open-source replacement boot ROMs, never proprietary Nintendo BIOS files. |

All native execution still requires the **real Windows x64 LPAC containment
probe**, zero network capabilities and owned Job supervision. No browser,
Linux, process-tree-only or administrator fallback was added. The core gets
one additional verified read-only root; it is not bundled into RetroArch.

These engines do not require WebGPU or an AI provider. This does **not** prove
their Windows audio/graphics/control compatibility under LPAC.

## Data lifetime and updates

- Identical imports have separate private identities; equal bytes never merge saves.
- Runtime rebinding retains the game identity, old package/version and source cache.
  Retrying the same rebind reuses its existing version rather than creating duplicates.
- Generated configs retain bounded backups. Rebinding snapshots managed
  configuration in existing default/mod profiles before changing pins.
- DOS working-copy content is intentionally mutable. Its trusted source identity
  is kept outside native-writable profile data. Conflicting new source content
  requires an explicit fresh profile, not a guessed progress migration.
- SameBoy restores only the immutable ROM, not its adjacent `.sav`/state files.
- RetroArch does not automatically load states from a different runtime/core pair.
  SRAM is retained; arbitrary cross-version state compatibility is not promised.
- **Known final-host check:** confirm where SameBoy/SDL actually stores native
  preferences under LPAC. Managed `prefs.bin` files are snapshotted when present;
  Windows-owned AppContainer preferences outside Arena's profile are not included
  in that backup yet. Do not claim a portable complete preference backup.
- Removal follows existing managed-package rules: stop owned runs first, retain
  profiles, and refuse removal of an installed game's referenced runtime/core.

## Independent provisioning

`desktop/build-classic-packages.mjs` uses exact official archive URLs, byte counts
and SHA-256 pins in `classic-pins.mjs`. No mutable nightly core DLL is accepted.
The core is built from pinned corresponding source and has its own content-qualified
version, license/source archive and compiler provenance. No compiler is shipped.

The Windows packaging workflow enables `ARENA_CLASSIC_PACKAGES=1`, provisions its
CI-only MinGW toolchain, and uploads independent TARs with the **same build's**
installer catalog. Runtimes/games are **not** added to the installer payload.
Local default packaging does not silently download this optional build set.
Preparation requires 2 GiB free scratch space; downloads are streamed and pinned.
DOSBox's debug executable/offline website assets are omitted, not its license notices.

Fixtures: original MIT DOS Coin Counter, original GB Coin Trail built with GBDK
4.5.0 (library notices/exceptions included), and the official freeware *Beneath a
Steel Sky* floppy data. The latter is **copyright Revolution Software**, not
public-domain or open-source game data: original readme/attribution are retained,
and the game must not be sold separately. Review all component/source obligations
before public redistribution; SHA pins are not a legal clearance or a signature.

## Evidence ledger — current host

| Check | Result |
|---|---|
| Linux protocol/storage/recipe tests | Passed; not execution of mocked engines |
| Frontend types / real IPC method wiring | Typechecked; native desktop UI not exercised in hosted browser |
| SameBoy, DOSBox, ScummVM upstream archives | Downloaded, SHA checked, actually extracted and repackaged; actual EXEs checked as PE x64 |
| Original GB fixture | Really compiled using publisher-digest-verified Linux GBDK 4.5.0; 32768 bytes, MBC1 battery, 8 KiB RAM |
| RetroArch 7z selection, Windows Gambatte build, Windows GBDK build, supervisor compilation | Prepared in CI; **not run on this Linux host** |
| Actual Arcade-controlled Windows startup, controls, physical audio, controller mappings, progress after reopen, clean Job cleanup | **Not demonstrated here; deferred final Windows pass** |
| SameBoy external native preference backup | **Unresolved until final-host path/persistence check** |

No adapter is labelled supported from this ledger. Runtime installation, source
inspection, process startup, package hashes and model readiness are not gameplay proof.

## Exact final acceptance

Build the matching Windows artifact set, then on the final Windows desktop:

```
node desktop/check-classic-runtimes.mjs <matching-package-directory> <matching-native-supervisor.exe>
```

This owner-interactive runner uses the actual packages, LPAC probe and Arcade host,
not a replacement process launcher. For **each** adapter: install exact dependencies,
launch its legal fixture, visibly control it, hear real output, create nonzero
progress, exit, reopen the same profile and observe the restored score/scene.
It checks saved-file hashes/counter bytes and records exact pins, OS build, helper
hash and owned exit phases. Headless/no-audio/unsupported hosts fail, never simulate.
Observations remain explicitly owner-reported; the report does not set gameplayVerified.

Also complete the native UI journey: approve an import, reject/cancel another,
retry a missing dependency, switch an exact runtime/core pin, inspect config
backups, verify the old version/progress remains, and remove files while preserving
saves. Check a real controller and SameBoy preference persistence separately.
Interrupt a run, confirm Job descendants drain, reopen and verify progress still
loads. A failure is a blocker with its precise host/pin/profile, not a support badge.
