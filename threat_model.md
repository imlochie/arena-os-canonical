# Threat model: desktop Arcade execution boundary

Scope: the native Arcade addition, not a completed review of every Arena room.
The native Windows implementation is **not yet execution-verified**.

## Assets and trust boundaries

- Existing browser games, private browser/runtime state, source histories and saves remain in their existing stores.
- Desktop package archives, immutable installations, private game profiles, local logs and the owner's unrelated files are separate assets.
- The owning Electron main process is trusted. The renderer, imported game code, game output and archive contents are not privileged.
- Hosted previews have no Electron bridge and no native-execution HTTP endpoint.
- Game/runtime artifacts are approved against the packaged catalog's exact archive and per-file hashes. The catalog is trusted application configuration, not a renderer-supplied manifest.

## Required guarantees

### Spoofing and elevation of privilege

Only the owning main-frame WebContents at the exact local application origin may invoke structured native controls. Subframes and other windows are rejected. Installation, launch and removal require main-process native confirmation; no renderer flag substitutes for approval or OS proof. Same-origin renderer compromise is not ruled out by origin checks, so confirmations remain necessary.

Games never receive database, session or provider credentials. The supervisor gets a narrow OS environment; the game gets a separately constructed environment. There are no arbitrary command, shell, PID, URL or path operations exposed through preload.

### Tampering and information disclosure

Acquisition checks exact size and SHA-256 before parsing; extraction checks declared file paths, sizes and hashes, rejects links/devices/ambiguous Windows paths, and activates through staging. Launch rechecks installation bytes. Browser exports contain management metadata, never source/ROM/save payloads.

The Windows design requires LPAC, no additional capabilities or loopback exemption, per-game filesystem ACLs, an explicit inherited-handle list and suspended creation before assignment to a bounded Job. Missing APIs, ACL failures, unsupported storage or failed probes must block execution. A process tree or Job alone is not containment. Optional audio/graphics compatibility must not silently weaken this policy.

### Denial of service and lifetime

Job memory, process-count and CPU limits supplement the OS boundary. A private parent control pipe, explicit stop and kill-on-close Job own process lifetime. Old PIDs are never acted on during recovery. Game stdout/stderr are encoded as untrusted log fields, separately from supervisor protocol; capture and retained run history are bounded.

Download, staging, installation, build-cache and profile storage are accounted separately. Installation requires a budget and free-space reserve; removal leaves profiles intact and cannot remove a referenced/running runtime. Running games have a monitored free-space reserve: **this is not a hard per-directory disk quota**, and burst writes or unrelated disk users can still exhaust a volume.

### Repudiation and evidence

Archive acquisition and installation records are not startup/gameplay proof. Common manifests bind evidence to content version, runtime/version, profile and host-session identity. Process creation does not promote gameplay. Unit subprocess simulations are never Windows isolation evidence.

## Outstanding verification

Real MSVC compilation and actual Windows LPAC filesystem/network/memory/descendant tests are required. SDL device initialization, native-window keyboard input/render readback, repeated-save restoration and shutdown behavior also need a real Windows run. Hosted CI without a desktop/audio endpoint may fail those checks; dummy audio or a skipped check is not an acceptable pass.

## Scan anchors

- `desktop/arcade/control.mjs`, `desktop/arcade-preload.mjs`: authority and confirmations.
- `desktop/arcade/packages.mjs`: acquisition, extraction, integrity and storage lifecycle.
- `desktop/native/arcade-host.cpp`, `desktop/arcade/host.mjs`: OS boundary, protocol and lifetime.
- `desktop/arcade-windows-acceptance.mjs`: real-host evidence; not executed in this Linux workspace.
