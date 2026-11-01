# Repository acquisition/build boundary

Extends the native-execution boundary in `threat_model.md`; not a whole-app security assessment.

| Boundary / attacker action | Enforcement |
| --- | --- |
| Renderer supplies a shell command, filesystem path, executable or arbitrary URL | Desktop IPC accepts only a token/asset index tuple or an existing managed key; native owning-window/main-frame/origin checks and a separate native owner dialog remain required. |
| Repo changes after review, tag collides with a branch, license is missing | Immutable Git commit/tag-object resolution; license and files verified against Git tree blobs; owner-bound expiring reviews; no automatic installation. |
| Source tries to run CMake/npm/README setup on the host | Fixed direct recipes; no shell or global package installation; compiler/editor only from pinned publisher ZIPs. |
| Godot tool script or compiler exploitation reads private files, sends network requests or spawns outside containment | Live Windows LPAC proof before build; precise SDK read roots and one private writable build root; no network capabilities, restricted descendants, Job limits and kill-on-close; no host fallback. |
| Source plants a junction/hard link to trick privileged postprocessing | Stop all owned descendants before traversing output; validate the complete writable tree/ancestor chain and reject links before owner-side copy/read/provenance writes. Installer and ZIP parser reject links independently. |
| ZIP/tar traversal, special entries, oversized output, corrupt data | Publisher archive SHA-256 first; bounded lazy ZIP streams, regular files only, strict Windows paths/case uniqueness; deterministic streamed USTAR with pinned per-file hashes and sizes. |
| Malicious DLL resolution | Child environment excludes provider/session credentials. DLL search adds only validated read-only runtime/SDK roots and system directories, never inherited host PATH. Source/release game CWD is its read-only executable folder, not the writable profile. |
| Failure/cancel/crash overwrites working game or save | Versioned immutable packages; retained compiled archives; activation only after integrity checks; selection changes after activation; profiles separate from versions. Cancellation stops the owned supervisor; shutdown waits for build cleanup. |

Residual limits:

- Windows helper compilation, real LPAC editor/compiler/SDL/Godot compatibility and packaged UI acceptance remain deferred to the final Windows pass.
- Static classification is not proof of a game. Successful compilation/export, process creation, manual observations and automated gameplay are distinct evidence levels.
- A publisher digest pins bytes; it does not prove binary/source equivalence or remove third-party license obligations.
- SDKs are trusted native tools, not permission for repository plugins/commands on the host.
- Resource preflight plus a 250 ms free-space guard is **not** a hard writable-directory quota. Fast writes can consume more than a sampling interval; pathological growth/slow filesystems must be exercised in the final resource pass.
- Exact inputs/recipe/SDK versions are pinned and output replacement is forbidden; bitwise Godot rebuild determinism remains unverified.
