# Repository acquisition and isolated builds

## Evidence boundary

Implementation is wired, **not a Windows compatibility pass**. The owner deferred target-Windows verification to the final Windows pass. Neither the native helper changes, Godot export/playback nor LLVM/SDL compilation have been executed on Windows here.

Passing Linux unit tests demonstrate validation, packaging and lifecycle logic only. The synthetic compiler adapter is explicitly a unit fixture, not compilation or gameplay evidence. Original local source fixtures below are not presented as public GitHub game imports.

## User workflow

1. Arcade → Imported games → confirm import rights → enter a public GitHub repository, release tag, or pinned commit/folder URL.
2. **Review project** shows the immutable commit, license verified against that tree, static game-entry evidence, languages, dependencies, SDKs, targets, source size and release assets. Scripts/addons are not advertised as a proven mod API.
3. Browser projects continue into the existing inspect → reviewed files/license → bounded offline browser import. Their private shelf and saves are unchanged.
4. Desktop Godot/SDL projects expose a separate rights confirmation and **Build from source**. A main-process native dialog still approves the operation. The hosted web app cannot build or execute native projects.
5. Native games shows actual acquisition/build phases, bounded logs, Cancel operation, pinned SDK information and SDK cache reset. A completed build transitions to Native games; Launch is a separate approval, not automatic gameplay.
6. **Use this version** selects an integrity-checked retained installation. Versions share their stable game identity/profile, not install directories. Removing the selected version falls back to another installed retained version or clears the selection; saves remain.
7. Release assets first require **Review this release**. Only a matching reviewed tag, identified Godot/SDL project, supported open-source license, publisher SHA-256, explicit Windows x64 target and portable ZIP enable installation. Missing digests, installers and ambiguous layouts are refused.

## Source and provider boundary

GitHub is the only implemented provider. Its read-only provider interface can be extended without granting arbitrary URL fetching or execution. This is URL-based discovery; there is no pretend cross-provider search.

Review tokens are owner-bound, replaced on re-review and expire after five minutes. Repository metadata uses fixed public GitHub endpoints, validated/pinned DNS, bounded responses and no ambient credentials. Release tags resolve through tag objects to commits, not ambiguous same-named branches. License and acquired file contents must match Git blob hashes.

Limits: complete tree ≤2,000 nodes; native source ≤256 files / 16 MiB. Truncated trees, links/submodules, LFS pointers, unsupported license/layouts and missing native dependencies yield actionable failures. A large repository is not treated as supported merely because it contains a small example.

## Explicit recipes

- **Godot 4 standard:** pinned 4.7.2 Windows editor; isolated headless resource import and pack export using an application-owned Windows preset. The resulting PCK uses the separately pinned Godot runtime with compatibility OpenGL; no WebGPU is involved. No .NET or native extensions. UID main scenes must resolve during import. Editor tool scripts can execute, but only inside LPAC.
- **SDL2 C:** one root `main.c`, local headers/assets, pinned LLVM-MinGW Windows x64 toolchain and SDL2 2.32.10 SDK. Fixed direct compiler flags; no repository CMake/npm/README commands. PE target checked as AMD64. Shared SDL runtime DLL is a separately verified managed runtime, available in the child's narrowly constructed DLL search path.
- **Portable release:** publisher ZIP digest checked before lazy regular-file extraction; one non-installer x64 game executable required. No binary/reproducible-source equivalence is inferred from a release tag.

Godot and SDL source fixtures are original MIT examples under `desktop/native/source-fixtures`. They are acceptance inputs, not preset substitutes for repository capability.

SDKs download only after owner approval, not while packaging the Arena installer. Official vendor archive digests and versions are pinned in application code; no global package manager or SDK setup script runs. Unneeded SDK architectures are omitted. SDK ZIPs are removed after verified activation; disposable caches can be reset without touching installed runtimes/games/saves.

## Execution, recovery and resource limits

Native source commands use the same live-probed Windows LPAC/AppContainer supervisor and Job limits as native play: no network/clipboard, 512 MiB per process, 1 GiB total, 16 processes, 25% CPU. Only exact SDK read roots and a separate writable build workspace are exposed. No host execution fallback.

After all owned descendants stop, main-process output handling rejects workspace junctions/symlinks/hard links before reading/copying/writing provenance. Game/runtime output is streamed into deterministic hash-pinned USTAR packages and activated through the existing recoverable manager.

Each command has a five-minute timeout; a source job has a ten-minute overall deadline. The managed 8 GiB budget and 512 MiB reserve use preflight and periodic free-space checks. **This is not a hard filesystem write quota.** Large SDK acquisitions and untrusted import amplification remain subject to the final resource tests.

Output identity includes source commit/blob hashes, recipe and SDK pins. Identical installed input sets reuse verified output. A different output cannot silently replace an existing immutable version. Bit-for-bit Godot rebuild reproducibility has not been demonstrated; pinned build inputs are not that proof.

Interrupted jobs become interrupted, not successful. Failed/cancelled builds do not switch the selected version. Workspaces are disposable, existing installs/profiles are preserved, and installed dynamic descriptors survive desktop restart. Repair uses retained pinned package archives; a reset SDK is reacquired on the next approved source build.

## Checks available now

- `node --test desktop/repository-builds.test.mjs desktop/arcade-packages.test.mjs desktop/arcade-control.test.mjs`
- `pnpm --filter @workspace/scripts exec tsx --test /absolute/workspace/artifacts/api-server/src/imported/arcade/repository-source.test.ts /absolute/workspace/artifacts/api-server/src/imported/arcade/repository-assessment.test.ts`
- Generated OpenAPI clients/Zod contracts and frontend/API type checks.

## Final Windows acceptance — deferred, not passed

Use the helper built with the matching app, an interactive audio-enabled Windows x64 desktop and an explicitly disposable test root:

```powershell
node desktop/arcade-source-acceptance.mjs --helper "PATH\arena-native-host.exe" --root "generated-artifacts\arcade-source-pass" --allow-sdk-downloads
```

This acquires real pinned SDKs, compiles the SDL source fixture, imports/exports the Godot fixture, verifies packages, launches both in the real native driver and reuses the exact input build. It requires explicit manual observations of visible drawing, keyboard-driven score/position, audible tone and restored visible progress after a second launch. JSON records manual observations separately; `automatedGameplayVerified` remains false.

The final pass must additionally exercise the **packaged Electron UI**: owner token → source/release review → native approval/cancel → real SDK acquisition/build log → Native games → launch/stop; remove/repair, update/retained-version selection, cancellation during download and during import/compile, interrupted restart, reserve exhaustion and whole-app shutdown. Also use actual licensed public browser, Godot and supported SDL repositories, retaining their exact URL/commit/publisher pins and observations. Local fixtures and API mocks do not establish that real-world repository coverage.

Until that pass, do not report Windows native builds, SDL audio/graphics, Godot gameplay, hard disk containment or broad engine compatibility as verified.
