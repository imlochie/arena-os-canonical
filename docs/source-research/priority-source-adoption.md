# Priority source investigation and adoption

## Status and evidence boundary — 2026-11-01

User objective: use these sources to make Arena a genuinely capable local-first
workspace, across all relevant rooms, rather than add presets, promises, or
unconnected applications.

This is **an inventory, implementation-path investigation, and first reliability
adoption—not a completed integration of these applications**.

The machine-readable [inventory](priority-source-inventory.json) records all 73
repositories: KytyPS5, REA, and the 71 public repositories returned for Storytold.
Each has an Arena fit, adoption status, review depth, and immutable revision where
one resolved. There are 72 resolved heads; AniCraft did not resolve a head.

Coverage:

- 59 source trees retrieved; 38 also have selected entry-source inspections.
- 21 have tree-level coverage without a selected entry-source inspection.
- 13 remain at README/manifest coverage because GitHub returned HTTP 403 for
  tree requests. A bounded shallow-Git fallback timed out; it did not resolve
  those gaps. They remain explicitly listed in the inventory.
- Additional targeted code inspection covered the main execution entrypoint,
  import, mixer, audio-format, web bootstrap, provider policy, evidence,
  reference-import, registry, and persistence paths in the five priority cores.
- Filename counts labelled `testFiles` describe test-like paths, **not executed
  tests or proof of upstream correctness**. Rust inline tests are not counted.
- No upstream application was built, installed, or executed during this pass.
  No screenshot, README claim, tool count, or source-file presence establishes
  gameplay, recording, conversion, AI generation, or editor usability.

### First concrete adoption

`desktop/atomic-file.mjs` is an original Node implementation informed by
`storytold/craft-libs/crates/atomic/README.md`, at revision
`f8f8829cc7be65d466d687dae381d1ca60e31242`.

Native Arcade configuration writes, configuration backups, and the private
classic catalog now use private same-directory staging, a file flush before
replacement, and bounded Windows sharing-lock retries. Failed replacement never
unlinks the old destination to force success.

The four new fault-injection/file tests and fourteen existing native/package
tests pass. Windows lock conditions were **simulated on Linux**. This does not
prove Windows execution, complete power-loss safety, directory durability, or
equivalence to the Rust crate. Arena retains its own strict profile/link
validation; it does not adopt the upstream document-writer's symlink-following
policy. No Rust toolchain, framework, or editor was added to the installer.

## What the three primary sources actually offer

### KytyPS5 → Arcade, conditionally

Reviewed revision: `893b03552699dc873474023bc1f4c69c57fb36b2`.

The repository contains a native C++ entrypoint, console GPU command/shader
translation, a Vulkan host backend, launcher code, and focused subsystem tests.
Its README advertises a PS5 translation layer and compatibility screenshots.
Those compatibility claims were **not independently reproduced**.

Actual integration constraints:

- Windows builds require clang-cl, Qt, CMake/Ninja, glslang and submodules. Its
  documentation explicitly does not support using cl.exe for the emulator.
  Arena's separately built native supervisor is a different component.
- Native Vulkan 1.3 and the documented CPU/OS requirements must be checked on
  the actual host. Lack of WebGPU in the hosted browser neither proves nor
  disproves native Vulkan support on the laptop.
- Keep acquisition optional, immutable and independently pinned. Do not put the
  build toolchain, all SDKs or game assets into the normal Arena installer.
- Review GPL terms, corresponding-source distribution and dependency notices.
  Do not paste its implementation into Arena's application code.
- Accept only owner-authorized game inputs. Do not acquire firmware, keys,
  protected game data, or implement DRM bypass.
- A runtime adapter needs explicit input, config/save locations, controller
  mapping, isolated writable profiles, owned-process cleanup and diagnostics.
  Whether it can run under Arena's current LPAC boundary is unverified; do not
  weaken containment merely to make a launch appear successful.

**Admission test:** acquire the exact authorized build, run a lawfully available
test/homebrew fixture, demonstrate visible interaction and audio, retain real
progress over exit/reopen, and prove all child processes stop. Only then consider
per-title compatibility evidence. A generic “PS5 supported” badge is not justified.

### REA → Arcade, Spaces, and shared inspection tools

Reviewed revision: `53363166f068a21f00a605187e1c3af428aa7d5d`.

The TypeScript package exposes CLI/MCP tooling and substantial provider,
reference-source, browser, binary and evidence infrastructure. Relevant inspected
paths include:

- `src/application/ReferenceSourceImportPolicy.ts`
- `src/application/ReferenceSourceImportTypes.ts`
- `src/application/binary/SessionProviderPolicy.ts`
- `src/config/mcpToolFamilies.ts`

Useful integration paths are **not** “install every analysis tool”:

1. Authorize a concrete local target or owned browser workspace.
2. Discover the selected provider's actual operations and readiness.
3. Advertise only the tool families needed for that room/task. REA explicitly
   scopes schemas to avoid paying context for every available tool.
4. Retain structured observations, provenance and limitations before asking the
   selected model to create or modify a project.
5. Keep live state live: do not reuse cached observations as current process or
   browser evidence.
6. Apply changes to the private Arena project, validate them in its actual
   runtime, and retain identity/progress through revisions.

CLI/MCP compatibility alone does not establish safe embedding. Active debugging,
process attachment, command execution, file writes and network access need
separate owner/target policies. An MCP schema is not a sandbox. Browser state,
cookies and unrelated application memory must never become general model
context. Imported source remains local/private unless the owner explicitly
requests a model handoff.

Provider prerequisites and licenses need per-provider checks. Do not turn
commercial analysis engines or cloud models into mandatory dependencies for
Arena's free/local path.

**Admission test:** inspect a small owned browser game, produce evidence of a
specific interaction, modify that interaction through the selected real model,
and run the result in Arcade while preserving its save identity. Deny an
unapproved file/process target and prove cancellation/cleanup. Test Spaces
against its own workspace, not a developer's unrelated browser session.

### Craft Anything → the study/build/check loop, not a shortcut around models

Reviewed revision: `1c7a7b8ef150523ccc8eec8c8c99729865dccfe3`.

Inspected engine registry, evidence model and rebuild-project paths. It provides
a structured study → build → check → refine architecture, CLI/MCP surfaces and
engine integrations. This closely matches Arcade's intended prompt-driven
creation/modding and Spaces' task-oriented workflows.

Important upstream admission: its README distinguishes the Claude Code builder
path from API-key/other-agent paths that were built but **not run live**, and
describes some app/game checks and engine tools as partial or tested with
stand-ins. It is not proof that Arena's chosen local Windows model works.

Borrow the evidence/obligation loop and target-specific acceptance, not a hidden
Claude subscription or fal.ai dependency. Arena must still make a real call to
the selected local model, validate the returned source, and execute it.

## Room-by-room adoption map

These are implementation tracks, not claims that the features are installed.
The inventory accounts for **every repository**, including non-adoption cases.

| Arena workflow | Sources | Useful capability / required boundary |
| --- | --- | --- |
| Waveyard session → Studio | SoundCraft engine/model/time/mix | Preserve stem identity, source offsets, sample positions, gain/fades/automation and return-to-session context. Do not replace the existing live mixer with an unrelated editor window. |
| Waveyard import/export | SoundCraft audio-io/import | Sample-rate-aware imports, BWF timestamps, format validation and DAW interchange. Verify full clip placement and audio, not just opening a project. |
| Waveyard playback/editing | SoundCraft playback/DSP/automation | Investigate native/worker rendering, metering, route and plugin capabilities against current bottlenecks before porting. Native plugin hosting is not browser plugin support. |
| Waveyard archival/capture | SoundCraft audio-io; existing Arena capture | Reuse useful format/metadata concepts without discarding the existing WASAPI/FFmpeg path. A generic audio editor is not an Apple Music converter or verified application-loopback recorder. |
| Voice tools | realtime-voice-conversion, torchscript-models, storyteller-ml, vits-finetuning, voder-proxy, discord-vocodes, fakeyou-recast | Inspect model/runtime contracts, latency, weights, consent and licenses. Legacy hosted proxies and redirects are not local voice engines. |
| Arcade study/create/mod | REA, Craft Anything | Authorized target → observations → explicit local-model call → editable original implementation → isolated gameplay proof → preserved progress. |
| Arcade console engines | KytyPS5 | Optional native experimental adapter only after host/containment and legal-fixture execution proof. No universal game claim. |
| Spaces automation | REA browser/provider paths; Craft Anything evidence | Task plans that operate a dedicated workspace and verify results; scoped tools, cancellation, privacy and reproducible observations. |
| Image editing | PhotoCraft, LightCraft | Layered raster/non-destructive editing, supported input/export formats, assets returning to the same Arena project. Actual build/format tests still required. |
| Vector/interface/layout | VectorCraft, FigCraft, DesignCraft | Document models, geometry/layout and export/asset handoffs. Native egui surfaces are not React components to paste into Arena. |
| Video/motion | FilmCraft, EffectCraft; AniCraft | Timeline/compositing and render/interchange candidates. AniCraft had no resolved head; it cannot currently provide an engine. |
| Documents/PDF | WordCraft, PdfCraft, indd-utils | Document/PDF editing/import/export; INDD→IDML only to the extent demonstrated by actual files and format code. Preserve originals and surface unsupported content. |
| Spreadsheet/slides/CAD | GridCraft, DeckCraft, CADCraft | Optional engine-backed project tools, round-trip documents and format validation. Do not add empty rooms before complete create/edit/save/export flows exist. |
| Shared correctness | craft-libs | Atomic writes, guarded document paths, settings, dialogs, platform lifecycle, fonts, text and media support. Adopt selectively; retain Arena's trust model. |
| Shared AI | craft-ai-integrations; craft-libs ai-core | Provider/consent/history contracts and consistent tool routing, without replacing Arena's configured local providers or silently uploading source. |
| Model/tool setup and updates | craft-launcher | Inspect platform/CPU matching, incremental install/update, cancellation, size/space planning and lifecycle recovery. Actual engine launch remains separate evidence. |
| Fonts, print, internationalization | craft-fonts, font-preview-service, craft-i18n, winprint.rs | Optional licensed fonts, bounded previews, translations and platform-specific printing. Do not package every font or assume Windows printing works elsewhere. |
| Rendering/framework dependencies | egui, winit, spark | Dependencies only when a selected engine needs them; actual GPU/backend checks. Spark is a conditional 3D Gaussian-splat renderer, not a general game engine. |
| 3D/hardware/game-engine interop | cloudcam, LiveScan3D, Kinect/Unreal/OSC/ZeroMQ plugins, RuntimeAudioImporter, RuntimeFilesDownloader, Bevy/mocap projects | Conditional hardware and engine integrations. Keep hardware prerequisites, data rights, large demo assets and missing licenses explicit. Do not regress Arena's bounded download/import protections. |
| Larger creator stacks | artcraft, artcraft-services, artcraftx | Study local jobs/projects/providers and useful components. Do not import the entire cloud stack, secrets or media history. |
| Regressions and fixtures | photocraft-corpus; applicable source tests | License-checked fixtures and format expectations, with actual runs recorded separately from test-file counts. |
| Infrastructure, demos, scaffolding and branding | remaining inventory entries | Explicitly accounted for; no new capability from redirects, placeholders, cloud IAM examples, launcher artwork or empty repositories. Revisit only for a concrete need. |

### SoundCraft findings that prevent regressions

Reviewed revision: `7169dc492eab3d068baa05bd2b0fd303409a86ac`.

`crates/audio-io/src/lib.rs` distinguishes readable formats from encoder output:
the inspected encoder options accept WAV, AIFF and FLAC and reject unsupported
formats. This is **not** an MP3/AAC/ALAC encoding replacement for FFmpeg.

`crates/engine/src/io/import.rs` explicitly separates slow decode/resample/peak
work from placement, and rescales BWF timestamps to the session sample rate.
Those are useful implementation contracts for fluid Studio imports. Their
presence does not establish correct round-trip behavior in Arena.

`apps/soundcraft-web/src/web.rs` starts an actual player and an egui renderer;
its failure UI requires WebGPU or WebGL2. “Pure Rust” does not mean GPU-free,
zero-cost embedding, or immediate compatibility with the hosted preview.

Before selecting any engine, inspect its exact license files, transitive
dependencies, formats and assets. GitHub's reported license and Cargo's package
label can differ; neither alone is a distribution review.

## Integration architecture and order

Keep Arena's rooms as focused interfaces over shared private projects, assets,
tools and runtime ownership. Select the least invasive supported boundary:

1. **Original in-process improvements** for small, understood algorithms or
   contracts, with attribution and regression tests.
2. **Worker/WASM engine components** where their actual API, threading, memory,
   codec and browser-backend requirements fit.
3. **Optional native CLI/MCP sidecars** with immutable packages, exact tool
   schemas, explicit permissions and owned-process lifecycle.
4. **Document/asset round-trips** when a full editor cannot be embedded usefully.
   Preserve originals and all unsupported data; do not silently flatten edits.

These are proposed boundaries, not an existing universal adapter in Arena.
Do not ship all upstream apps, build toolchains, weights, fonts, or demo assets.
Do not bulk-merge external work or remove Arena capabilities based on README
feature overlap.

Priority sequence:

- Complete the recorded source-depth gaps, exact license/dependency reviews,
  current Arena boundary traces and per-engine capability probes.
- Prove SoundCraft's useful audio/interchange components against an authorized
  Waveyard session, including offsets, fades, rate/bit depth, actual playback,
  save/reopen and preservation of unsupported edits.
- Prove one authorized REA/Craft Anything study → selected local model →
  editable game → isolated gameplay/progress loop. Expand shared tool routing
  only after that works without a hidden paid provider.
- Bring media/document engines in through complete create/open/edit/save/export
  workflows and project handoffs, not new labels on unfinished rooms.
- Evaluate KytyPS5 separately behind native host/containment and per-fixture
  compatibility proof. Do not let an experimental console engine delay core
  Waveyard/Arcade usability.

Prepare target-host checks now; respect the user's instruction to defer requests
for their Windows testing until the final pass. Browser/mobile fallbacks must
report unavailable native functions honestly, not display working-looking buttons.
