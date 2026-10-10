# Waveyard: the stem machine and the studio around it

*Status: ACTIVE VISION — this document is the identity and roadmap for
Waveyard. It supersedes the phase-report framing (PHASE_0–4 reports remain as
history). Decisions below were made by the owner on 2026-10-09.*

## Identity

**Waveyard is the machine your music goes into and comes out of better.**

Every track you drop becomes stems the moment it lands — separated on your
own CPU/GPU, no account, no worker, no internet — and then a real studio
grows around those stems: a player that mixes like an instrument, an
arranger, a mixer with real processors, a piano roll, and eventually a crew
of agents doing the technical work while you stay in the fun.

It is not a streaming platform. It is not a companion app for someone
else's speaker. It is not a front-end to a cloud. If a feature does not
serve *track in → music out*, it does not belong in the default experience.

## Why this exists — the stem.fm bar, honestly

stem.fm (STEM) sells the Stem2: a $299 360° speaker whose product thesis is
*on-device separation with zero setup* — "Separate vocals, drums, bass and
instruments, then shape the mix live with touch." That instant loop is the
correct bar, and their "brain" (song in → stems out → play immediately,
nothing to configure) is what Waveyard adopts.

Where Waveyard can be better **in its own right**:

| | Stem2 / stem.fm | Waveyard |
|---|---|---|
| Hardware | Their closed device, $299 | The computer you already own |
| Separation quality | Fixed DSP, frozen at purchase | Swappable models — quality improves as software |
| Stems | Exactly 4, fixed roles | Any number; 2-stem instant, 4-stem HQ, beyond-4 possible |
| After the loop | Nothing — you can mix, not make | A studio: arrangement, mixer + 26 processors, piano roll, MIDI |
| Library | Their catalog | Your files, local, forever |
| Automation | None | Governed agents that do the technical work (V5) |

One honest asymmetry, kept on record: stem.fm has a licensed catalog
("millions of songs") that we do not and will not pretend to. Our lane is
your music plus depth they cannot follow us into.

## What Waveyard is NOT (any more)

- **Not a platform first.** Discover / moderation / publication exist in the
  codebase and stay parked (kept, tested, out of the default navigation)
  until the core loop is stem.fm-grade. Decided 2026-10-09.
- **Not a Stem2 accessory.** The `stem2/` capability adapter stops being a
  priority; the honest audio-output routing it shares stays. The Stem2
  itself becomes a *target we own later* (V3), not a device we apologize to.
- **Never dependent on infrastructure for the core loop.** The words
  "worker" and "Redis" must never appear in a user-facing error in the
  default experience. (Today they do — see Current-state receipts.)

## Principles

1. **Plug and play or it doesn't ship.** From cold open to sound in seconds.
2. **Local by default.** The network is never required for the core loop;
   the only network moment is the one-time model acquisition (owner chose
   hybrid — see Decisions).
3. **Honest always.** No fake stems, no fake progress, no pretending a
   missing engine exists. Unavailable = an actionable state, never a
   fabricated success.
4. **The loop first.** Import → stems → play → mix. Everything else serves it.
5. **Your machine is the instrument.** Use the whole CPU (and GPU where
   present); upgrade quality by swapping models, not hardware.

## Decisions (owner, 2026-10-09)

1. **Engine distribution: HYBRID.** A compact fast model (~60–70 MB) ships
   in the installer so 2-stem separation works immediately and offline;
   higher-quality 4-stem models (~100–300 MB total) are acquired once, on
   first use, through the existing checksum-verified seeding pipeline (the
   same mechanism that delivers ffmpeg), then live on the machine forever.
   Contingency: if the fast model's license does not permit redistribution,
   it seeds too — same code path, no design change.
2. **Platform surface: PARKED.** Out of the default navigation; code and
   tests remain.
3. **Stem2 hardware: AFTER CORE.** Make Waveyard itself the stem machine
   first; then reverse-engineer the Stem2 (sideload/sync protocol, its
   64 GB storage) so Waveyard pushes OUR stem packs onto the device —
   Waveyard as the device's loading dock, not its client.
4. **DAW: NATIVE PIANO ROLL FIRST**, with MIDI-file interchange from day
   one (FL Studio opens our SMF natively). FL bridging (virtual MIDI +
   loopback audio) only if the native editor hits a wall.

## The roadmap

### V1 — The Stem Machine (plug-and-play local separation)

The flagship fix: separation runs entirely on the user's machine, in the
desktop runtime process.

- **Engine:** `onnxruntime-node` (MIT) loaded in the desktop runtime. CPU
  execution provider by default; on Windows probe **DirectML** (the GPU
  execution DLLs — DirectML.dll, dxcompiler.dll, dxil.dll — ship inside the
  npm package itself; verified from the tarball) with CPU fallback.
- **In-process queue:** register a `separation` handler on the
  `LocalJobBroker` (the desktop queue transport that already runs waveform,
  analysis, and render jobs with no Redis). Upload → separation starts
  immediately, in-process, with real chunk-level progress events.
- **The 503 wall is dead** (shipped): no user-facing path tells anyone to
  "start the worker/Redis" anymore — uploads persist and each durable job
  row records its own honest failure boundary. Server/Redis mode remains
  available for deployments that want it; in desktop mode the local
  handler takes priority.
- **Demix pipeline:** decode via bundled ffmpeg → resample 44.1 kHz stereo →
  STFT with per-model parameters (n_fft/hop/window read from each model's
  config — verified from the real files at integration, not from memory) →
  windowed overlapping chunks → ONNX inference → weighted overlap-add →
  ISTFT → stems persisted exactly as the cloud worker would persist them,
  so every downstream surface (availability, player, mixer, arrangement)
  lights up with zero changes.
- **Models:** `Kim_Vocal_2.onnx` (66.8 MB — vocals + instrumental,
  sha256-pinned in the registry). The seeding pipeline is implemented:
  first use offers "Prepare stem engine (one-time download)" — the
  registry-pinned file is downloaded, checksum-verified, and installed
  atomically, then every separation that failed for want of the model is
  re-enqueued automatically. Bundling the fast model in the installer
  remains open pending the license check; the seed path needs no design
  change either way. HQ seeded set from the canonical
  `huggingface.co/Politrees/UVR_resources` repo (MDX-Net family: Inst_HQ
  series, kuielab challenge models) follows the same pipeline.
- **Packaging (shipped, verified by staging run):** onnxruntime-node is a
  `serverExternalPackages` entry (Turbopack otherwise bundles the JS wrapper,
  which then cannot find its native binding — proven before the fix) and its
  native binaries are force-traced into the standalone server
  (`outputFileTracingIncludes`); `scripts/desktop-prepare-server.mjs` prunes
  the bindings to the build platform/arch (288 MB → ~64 MB for win32-x64)
  and hard-fails if the runtime is missing from the staged tree. No
  `asarUnpack` is needed — the server ships as extraResources outside the
  asar archive and runs in a separate Node process. The package's
  postinstall only fetches CUDA extras (unused); installs run with
  `--ignore-scripts` and stay deterministic.
- **Testing honestly:** CI/sandbox cannot fetch model weights (network
  policy) — the demix math (STFT/chunking/overlap-add/windowing) is
  unit-tested against synthetic signals and hand-computed references; the
  inference path is tested with an injected fake ONNX session (the proven
  governance/isolation/browser pattern); the honest-unavailable states are
  tested for real; live separation is verified on the owner's Windows
  machine as part of acceptance, with real timing numbers recorded.
- **Acceptance:** clean install (offline after model acquisition) → drop an
  arbitrary MP3 → stems playing, zero configuration, no infrastructure
  vocabulary anywhere in the UI.

### V2 — The Playing Experience (the stem.fm loop)

The app opens straight into the music. Default navigation: Library, Player,
Studio — nothing else.

- The four-stem object is the primary visual language everywhere: artwork +
  vocals/drums/bass/other as first-class, touchable, keyboard-mixable.
- Player upgrades to instrument-grade: per-stem faders/mute/solo, instant
  loop, instant A/B, "thirty seconds to sound" from cold open (measured at
  acceptance on the owner's machine).
- Library: every track shows its stems at a glance; search/filter; sessions
  surface as playable sets.
- Platform pages (discover/moderation/publication) leave the default nav
  (parked, per decision 2).

### V3 — Owning the Stem2

After the core is stem.fm-grade: reverse-engineer the Stem2's loading and
sync surfaces (their web loader, Wi-Fi, USB), define the **stem pack**
(4 stems + metadata + artwork), and make Waveyard the loading dock that
pushes packs onto the device's 64 GB storage — plus the honest audio-output
routing we already have. Honest dependency: needs the physical device and
protocol research; sequenced deliberately after V1/V2.

### V4 — The Studio (piano roll, MIDI, customization)

- **First slice shipped:** the native piano roll is live in the studio. A pure,
  fully-tested domain model (`studio/piano-roll.ts`) drives a real editor
  (`PianoRoll.tsx`): draw/move/resize notes on the project's analysed beat
  grid, snap settings bar→1/16, multi-select, duplicate, transpose, quantize,
  velocity lane, and keyboard editing (Delete, Ctrl+D, arrows, Ctrl+A). Every
  arrangement layer gets an in-place editor — saving re-renders the layer's
  real audio with the same instrument (the stored WAV is always exactly what
  the notes say) and the layer's provenance records the edit.
- MIDI-file interchange from day one: SMF read/write exists in the codebase
  (`midi-file.ts`, both directions tested) and is wired per layer — export
  any layer as a Standard MIDI File at the project tempo (FL Studio opens it
  natively), import an FL-exported `.mid` back into the editor.
- **Vocal chops shipped (chipmunk-soul sampler):** the scan reads the
  project's separated VOCAL STEM — the Waveyard advantage, a clean vocal
  instead of a mix — detects the best one-shot notes (voiced-segment
  splitting, autocorrelation pitch tracking with octave-safe peak picking,
  quality-ranked by clarity/stability/length/level), and persists each chop
  as a normalised WAV (playable in the studio, downloadable straight into
  FL). The chop builder arms any chop and draws its pattern in the same
  piano roll — every note plays its chop resampled to the drawn pitch
  (up an octave = faster + brighter = the chipmunk effect) and the whole
  pattern renders to real PCM WAV on demand.
- Next: MIDI tracks on the timeline (clips referencing layer notes), recorded
  MIDI input, and hooking the insert chain (26 processors) + automation lanes
  to editor output.
- Customization: layouts and theming on the existing visual-state system.
- FL bridging (virtual MIDI port + loopback audio) only if the native
  editor hits a wall (decision 4).

### V5 — The Crew (agents on the bench)

Waveyard operations become Spaces agent tools behind the governance gate we
shipped in Phases A–D: `separate_this`, `build_a_practice_mix`, `master`,
`export_stem_pack` — background work with real progress, approvals for
consequential actions, and a journal that records which engine and model
ran. The crew does the technical work; the human stays in the fun.

## Verified ground (facts this plan stands on)

- **onnxruntime-node 1.30.0** (MIT): the npm tarball itself bundles the
  native binaries for win32/linux/darwin × x64/arm64, including
  DirectML.dll + dxcompiler.dll + dxil.dll for Windows GPU inference. The
  postinstall script only downloads CUDA extras (not needed for CPU) —
  verified by unpacking the tarball. ~287 MB unpacked total across all
  platforms; a single-platform packaged subset is a fraction of that.
- **Models:** MDX-Net ONNX models are 30–67 MB each, hosted canonically at
  `huggingface.co/Politrees/UVR_resources` (Kim_Vocal_2.onnx = 66.8 MB;
  Inst_HQ series; kuielab challenge models) with mirrors (Derur/UVR-models,
  Blane187/all_public_uvr_models, seanghay/uvr_models). File downloads are
  blocked from this build sandbox (network policy) — which the seeding
  design already accounts for: acquisition happens on the owner's machine.
- **Desktop queue transport exists:** `LocalJobBroker`
  (src/lib/waveyard/worker-local/broker.ts) already runs jobs serially,
  in-process, with an event model — separation is the missing handler, not
  missing infrastructure.
- **The rest of the pipeline is already local:** bundled ffmpeg decode,
  analysis (arena-js-dsp), waveform, render — all run on-device today.

## What V1 must verify before it is trusted

1. Per-model I/O signatures and STFT parameters (dim_t/dim_f/n_fft/hop)
   read from the real model files — never from memory or third-party docs.
2. License terms of the exact bundled model (redistribution permission).
3. DirectML availability and speed on the owner's GPU vs CPU (real numbers
   recorded at acceptance).
4. Separation parity: same model + same parameters against a reference
   separation (UVR) on the same track — verified, not claimed.
5. Real-world timing: cold open → stems playing, on the owner's machine.

## Current-state receipts (what motivated this document)

- `src/app/api/uploads/route.ts` (desktop, no Redis): returns **503 "Start
  the worker/Redis and retry this source"** — the flagship feature tells
  the user to configure infrastructure. This is the single clearest
  violation of Principle 1.
- The default surface spans platform pages (discover/moderation/publication)
  that have nothing to do with the loop.
- `src/lib/waveyard/stem2/` is an honest capability adapter for STEM's
  speaker (name heuristic, output routing, media keys) — well-built, but it
  made a device the priority instead of the machine music actually lands on.
- stem.fm product page (fetched 2026-10-09): Stem2 = $299, "Separate
  vocals, drums, bass and instruments, then shape the mix live with touch",
  on-device DSP, 64 GB storage. That instant, self-contained loop is the
  bar Waveyard must clear — and then go past, into the studio.
