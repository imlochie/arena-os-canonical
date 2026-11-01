# Desktop native execution: implementation and acceptance gate

## Current state

The native lifecycle, Electron control path, common runtime adapter/manifest
projection and Windows supervisor source are implemented. Linux storage,
ownership and simulated supervisor tests do **not** verify Windows containment.
No actual Windows/MSVC/SDL execution pass has been obtained in this workspace.
The user explicitly deferred target-Windows verification to the final Windows
pass so queued implementation can continue. This closes the implementation
step only; it is **not** a verified Windows-execution or release-readiness claim.
The final pass must cover the real-host acceptance and remaining gaps below.

The original SDL fixture is an acceptance game, not a replacement for Arcade's
prompt/import/mod vision. Reproducible repository builds and real mod loaders
remain separate queued work. Existing browser players and their save identities
are not migrated or replaced.

## Runtime and installation

- Windows x64 only; the supervisor requires NTFS without reparse/junction paths,
  usable AppContainer/LPAC/network-isolation APIs and successful Job assignment.
  Standard per-user installation needs permission to grant the probe SID access
  to the supervisor executable. Other layouts may be unavailable.
- The initial policy supplies **zero additional capabilities**. It must not be
  broadened just because a game fails initialization. In particular, SDL audio
  and other native dependencies need actual compatibility evidence under this
  exact policy. No WebGPU or AI provider is involved in native execution.
- Runtime packages are independent `.tar` artifacts, not bundled into the main
  installer. SDL 2.32.10's official Windows x64 ZIP is pinned to
  `6cf9706eefd0a4a06dc764007934d428afaf029fabdd408a9e646048c91e18fb`;
  the original publisher README accompanies its DLL.
- The main Windows package workflow publishes matching
  `arenaforge-native-packages-same-build` artifacts. Use the artifacts from the
  **same workflow run** as the installer. Game filenames include the exact
  version; archives from another build can legitimately have different hashes.
- The local native picker selects an archive; the renderer never supplies its
  path. Native dialogs approve installation, launch and removal. Stop remains
  available during other operations.
- Storage is under the existing Arena data root, in separate native downloads,
  staging, installed, build-cache and profile folders. Referenced/running
  packages cannot be removed; saves are not package contents.
- Installation interruptions retain cache/progress and discard private partial
  staging. Damaged/missing installed files block launch. Explicitly remove and
  reinstall a damaged package to recover; removal confirmation preserves saves.
  Older build installations are retained but cannot execute without their
  trusted catalog entries. A general version-rollback UI is not yet supplied.
- Disk limits for acquisition are preflighted. Running-game free-space checks
  are best-effort, not hard disk quotas.

## Real Windows acceptance

Prepare the regular Windows build, or compile only the native supervisor and
fixture using the manual **Windows Arcade containment and SDL acceptance**
workflow. It runs only when dispatched. A self-hosted runner can use labels
`self-hosted`, `Windows`, `X64`, `arena-audio`.

The workflow must:

1. Compile the actual native host and original SDL fixture with Windows MSVC.
2. Verify live LPAC identity, outside-file read/write/DACL denial, denied
   connections to a live loopback listener, Job limits, over-limit allocation
   denial and termination of an actually running descendant.
3. Install exact pinned SDL and game archives; reverify files before launch.
4. Open a real SDL native window; send Win32 keyboard messages to the expected
   process/window; verify rendered pixels, output-device PCM callbacks and a save.
5. Relaunch with the same isolated profile and verify visible state via the
   fixture's native-render/input evidence plus incremented persisted progress.
6. Request owned window closure with a bounded forced-stop fallback, preserve profiles during package removal,
   and retain a JSON evidence report. The fixture's report is not a blanket
   claim that other games or every host configuration work.

Run command after building:

```powershell
node desktop/arcade-windows-acceptance.mjs <path-to-arena-native-host.exe>
```

Evidence goes to `generated-artifacts/arcade-windows-acceptance/report.json`.
A non-Windows host, missing audio endpoint, absent desktop session, API/ACL/Job
failure or failed check is a failure, not a skipped pass. Audio callbacks prove
the device requested PCM, not acoustic audibility. Hosted Windows CI may lack
an audio endpoint; do not inject a dummy device to manufacture success.

## Remaining acceptance gaps

- Actual Windows run, including any compilation/SDK and LPAC compatibility fixes.
- Forced supervisor death, whole-app shutdown and EOF lifetime exercises beyond
  the probe's descendant-kill test and the owned-stop exercise.
- Actual installed Electron/native-dialog interaction, rather than just the
  owner-gate unit tests and standalone supervisor acceptance.
- Verified rollback among retained native versions, comprehensive crash-time
  uninstall recovery, and a hard writable-storage quota.

These gaps are why this task is not marked complete and no Windows-ready claim
is made.
