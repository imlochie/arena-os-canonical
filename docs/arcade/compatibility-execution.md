# Wine / Proton: admission assessment, execution still blocked

## Delivery status

Host-aware admission diagnostics are implemented. **A Wine launch adapter,
runtime provisioning, prefix management and verified Linux gameplay are not
implemented. This work is not complete and must not be called verified
compatibility-layer execution.** No Wine/Proton runtime is registered or offered
as a working install/launch action.

Windows x64 continues through the native LPAC/Job route. Windows ARM64 and other
architectures are not promoted into support by suggesting Wine. Hosted browser
previews cannot execute local binaries or inspect a visitor's laptop facilities.

## Verified current facts — 2026-11-01

The user subsequently chose to build Linux execution now rather than defer it.
The deeper admission work below was done in response. This changes priority,
not the meaning of a verified execution result.

- Current assessment machine is Linux x86_64, not a packaged Arena desktop.
- Initially Wine, wine64, wineserver, Steam and pressure-vessel-wrap were not
  found on PATH. Wine and the bounded diagnostic dependencies were subsequently
  installed for the deeper check. Presence is not gameplay support.
- User/mount/PID/network namespace creation successfully ran a `true` process.
  That verifies a kernel primitive, **not an allowlisted root filesystem, network
  denial test, resource controls, owned cleanup, or a registered game service**.
- X11 is advertised and its socket directory exists; PulseAudio answers a
  protocol query. No physical `/dev/dri` or `/dev/snd` directories were observed.
  No Wine rendering, input or audible-output behavior was tested.
- Existing `NativeArcadeHost` launches the Windows-only supervisor implemented
  in `desktop/native/arcade-host.cpp`; the actual backend is
  `windows-lpac-job-v1`.
- The Electron entrypoint/build assumes Windows Chromium and packaged Windows
  services. There is no existing Linux native control/launch product path.
- The Spaces container/host-jail command runner is not an equivalent game
  supervisor. Its host fallback and ordinary SIGTERM are not adequate Wine
  filesystem/network isolation or wineserver/descendant ownership.

Run `node desktop/check-compatibility-host.mjs` for a fresh read-only assessment.
It runs bounded ordinary OS diagnostics and checks command presence, never Wine,
Proton, installers or game inputs. Its output excludes environment values, raw
diagnostic output, credentials, browser state and game content. A connection or
installed executable never flips a runtime into `available`.

The current host has useful facilities, but lacks an integrated, supported
execution pathway. Installing Wine first would not resolve that architecture
gap.

### Deeper admission result

`node desktop/check-compatibility-host.mjs --probe-sandbox` is the opt-in
controlled probe. It returns exit **2**, not success, on this host:

```
status: blocked
cgroupControlsConfigured: true
privateProcMounted: false
probeGroupCleaned: true
code: PRIVATE_PROC_MOUNT_DENIED
diagnostic: bwrap: Can't mount proc on /newroot/proc: Operation not permitted
gameplayVerified: false
```

Independent read-only fresh-proc mounting in a new user/mount/PID namespace
also failed with permission denied (exit 32). Namespace creation alone had
passed. No host namespace policy, security controls or existing process groups
were changed. The temporary owned probe cgroup and files were removed.

The real cgroup-v2 memory/swap/process/CPU settings could be configured in an
independent owned group. This is **configuration evidence**, not an OOM,
game-child-cleanup or full containment acceptance test.

An inherited-capability incompatibility initially prevented Bubblewrap setup.
The trusted `arcade-linux-gate.c` clears effective/permitted/inheritable/ambient
capabilities and sets no-new-privileges, after the owner attaches it to the
probe's unique cgroup. Setup then reaches the actual private-proc permission
failure. It never advances to Wine or any untrusted program.

The check deliberately does not bind the owner's `/proc` as a workaround,
reuse the host network or display/audio sockets, or run uncontained Wine.
No prefix was initialized. No Windows game was compiled, downloaded or run in
this pass; the rejected cross-compiler package did not install.

To finish actual execution acceptance requires a Linux host permitting the
private-proc sandbox setup, followed by implementing the driver and passing the
gameplay/lifecycle checks below. A permissive primitive probe by itself must
still not enable an absent driver.

## Distribution and legal assessment

### Disposable Linux CI admission

The user selected a Linux CI runner for the next verification stage.
`.github/workflows/linux-arcade-admission.yml` is a manually dispatched,
read-only-repository-permission workflow on a disposable Ubuntu 22.04 x64 VM.
It downloads only admission tools from a fixed nixpkgs revision, not Wine,
game binaries or the full application dependencies. The Nix source URL pins
the Git commit; it does not currently carry an additional archive/NAR hash.

Systemd creates a dedicated runner-user service with delegated cgroup controls.
The probe derives its cgroup from its own kernel membership, rejects ordinary
runner/root groups, then creates and cleans up only its owned child group.
The privileged command starts the service; the Node/C probe runs unprivileged.
No host security policy is relaxed when namespace or procfs setup fails.
The service also has a hard lifetime and owned-descendant cleanup on exit.

The JSON report records the exact source revision, cleanup status and
`gameplayVerified: false`. A passing job means **admission primitives only**.
Real gameplay, input, captured audio, prefix/save lifecycle, repair, rollback
and actual game containment still require implementation and separate evidence.

The workflow has **not been dispatched or verified on GitHub**. The GitHub
connection was authorized but its callable credentials were withheld in this
session. Once these files are on the repository's default branch, use Actions →
“Linux Arcade isolation admission (not gameplay)” → Run workflow. Download
the `arcade-linux-admission-*` evidence, including failures. A failed bootstrap
can leave only `runner.log`; absence of JSON is not a passed probe.

#### Handoff and acceptance checklist

Local verification of the admission implementation:

```
node --test desktop/arcade-compatibility.test.mjs \
  desktop/arcade-linux-cleanup.test.mjs desktop/arcade-linux-gate.test.mjs
node desktop/check-compatibility-host.mjs --probe-sandbox
```

The 12 focused tests passed, including compiling and running the trusted C
launcher with missing, incorrect and valid grants. They execute trusted OS
`true`, not a Windows game. The real hosted sandbox probe returned exit 2 with
`PRIVATE_PROC_MOUNT_DENIED`, `probeGroupCleaned: true` and no cleanup errors.

Cleanup now handles failed cgroup attachment without leaving its blocked
launcher waiting indefinitely. Attached processes are terminated through their
owned cgroup; only an unattached, unreleased trusted gate can be killed directly.
Group-kill failure, child-exit timeout and group-removal failure are retained as
failure evidence; they cannot produce a passing admission status. Temporary
file removal is attempted even when group cleanup fails.

On the CI VM, accept **only the prerequisite stage** when all these are true:

- The workflow and tests pass for the intended source revision.
- `admission.json` exists and `sourceRevision` matches that revision.
- `status` is `primitives-only`, `cgroupControlsConfigured` and
  `privateProcMounted` are true, `probeGroupCleaned` is true, and
  `cleanupErrors` is empty.
- `gameplayVerified` remains false. A true value here would be invalid evidence.

Stop on a failed prerequisite; inspect `runner.log` and the JSON rather than
relaxing isolation. No Windows machine is needed for this CI stage.

Still not delivered: a registered Linux Wine game driver, pinned distributable
runtime closure, private graphics/audio forwarding, prefix provisioning and
save-preserving repair/rollback. Those must be implemented and exercised using
the representative game below before compatibility execution can be completed.

### Wine

[Wine 10.0's source license](https://github.com/wine-mirror/wine/blob/wine-10.0/LICENSE)
states LGPL 2.1 or later. This identifies a source candidate, **not a pinned,
redistributable ready-to-run Linux distribution**. A runnable distribution must
pin the Wine binaries, loader/libc/dependencies, host ABI and all relevant
licenses, and pass integrity checks. “Use whatever wine is on PATH” is not a
reproducible adapter.

A development candidate was acquired after namespace/cgroup facility checks:

- Nix package: `wineWowPackages.stable`, Wine **10.0**.
- Store root: `/nix/store/fcg184k2q4ij70dfl25j8zma4x8q9fq8-wine-wow-10.0`.
- Recorded NAR hash:
  `sha256:0q8qg8l5sqgjnvyyfnb7i35sljyxi2f7ws4vajblvk2gwl0qa2j2`.
- Selected `bin/wine64` SHA-256:
  `75b99edf914cf01e3b44290f73b55ff9440412e5c3a17b329bcf169e6ba057d7`.
- `wine64 --version` returns `wine-10.0`; this is a version-only observation.
- The separate 32-bit `wine` ELF fails with `Exec format error` here. No
  32-bit-host-ABI support is claimed, and the exact underlying cause was not
  diagnosed.

The NAR hash above was queried from the package database; it is not a fresh
full-closure tamper audit. There is no verified distributable Wine game adapter.
Wine/source presence does not provide proprietary Windows redistributable
rights. Native Windows packaging does not bundle this development Nix closure.

### Proton

[Valve's Proton 10.0 README](https://github.com/ValveSoftware/Proton/blob/proton_10.0/README.md)
describes Proton as a Steam-client tool and recommends the client-provided
version. Its build instructions also involve container tooling; building Proton
and launching a game are different prerequisite sets.

The documented Steam pathway needs a compatible Linux Steam client, tool/app
context, matching Steam Linux Runtime/pressure-vessel facilities, libraries and
graphics drivers. A standalone runner can be another pathway, but neither one
is implemented or verified here. Do not claim Steam is universally necessary
for every possible Proton integration, or that a proton script alone suffices.

Proton combines separately licensed components; Steam is not a freely
redistributable dependency to silently bundle. No Steam installation, system
driver setup, unsupported Replit container deployment or mock Proton adapter
was attempted.

### Representative legal game

Use Arena's existing original MIT SDL acceptance game, not an unverified
download or commercial title:

- Source: `desktop/native/arcade-sdl-fixture.cpp`
- Inspected source SHA-256:
  `1a8491044e29bd613b41680023547df92bfdd0138d465b7d85bb16eb5dadf1c8`
- Builder/catalog: `desktop/build-arcade-fixture.mjs`.
- Source and MIT notice accompany the independent package.
- The corresponding Windows PE, SDL runtime and package hashes must come from
  the exact matching successful build/catalog. A source hash is not a binary
  pin or proof of Wine compatibility.

The existing fixture provides visible interaction, score/save behavior and
synthesized audio. It has **not** run through Wine.

## Required implementation boundary

To finish without creating an unrelated Linux desktop product, first establish
an explicit supported Linux host entrypoint for the existing owned execution
service. This requires architecture work, not just adding `wine game.exe`:

1. Live denial/cleanup/resource probes for a Linux game supervisor. Namespaces
   must be combined with an allowlisted root and enforced ownership/limits;
   neither a working directory nor a process group is a security boundary.
2. Read-only immutable runtime/game roots; a per-game/per-profile writable
   root and explicit non-inherited environment. Never expose owner home,
   credentials, host `Z:` mappings or shared default `~/.wine`.
3. Initialize Wine prefixes only inside that verified containment. No
   uncontained wineboot, arbitrary installer scripts or fallback to a host shell.
4. Independent display/input/audio access. Passing the shared host X11 socket
   can expose unrelated windows/input; passing a shared Pulse socket can expose
   capture/monitor sources. A successful connection is not safe least-privilege
   access. Use an isolated presentation/audio pathway or verified brokers.
5. Owned wineserver/helper lifetime, prefix locks and all-descendant shutdown.
   Never terminate the owner's unrelated Wine instances or recycled PIDs.
6. Prefix identity must bind game, profile, architecture and exact runtime
   lineage. Retain save/configuration roots and private registry state.
7. Snapshot stopped prefixes before repair or migration. Wine version changes
   can modify prefix registry/runtime state, so a binary-only downgrade is not
   a complete rollback. Preserve newer game progress; never silently restore an
   older prefix over it. Repairs need explicit owner-reviewed copies.
8. Fit provisioning/repair into existing budget/reserve/cancellation semantics.
   Account for prefix, dependency, staging, backup and shader-cache disk usage.

## Completion evidence still required

Record exact host OS/architecture, native supervisor, Wine distribution and
dependencies, game/SDL hashes, profile/prefix identity and observed facilities.

Then demonstrate through the actual shared game manager:

- acquisition and prefix initialization with deny tests already passed;
- real visible game control and observed/captured game audio;
- nonzero saved progress surviving ordinary exit and relaunch;
- independent game and mod profiles, without touching other Wine prefixes;
- child/helper/wineserver shutdown, crash recovery and refusal to repair a live
  prefix;
- stopped-prefix backup/repair, failed upgrade and rollback while preserving
  current progress;
- cancellation, storage failure and missing display/audio/ABI prerequisites.

Keep Proton unavailable unless its complete chosen distribution/runtime/launch
path passes equivalent evidence. No readiness flag is accepted as gameplay
proof. Linux Wine acceptance is distinct from the user's deferred final Windows
native test; do not pressure them for Windows testing to resolve this gap.
