# Waveyard Completion Plan — audit + priorities

Status: **engine increment (P0/P1/P2 core) implemented; UI console wiring next.**
Companion: `docs/arena-branch-convergence-audit.md` (log), `docs/windows-desktop-architecture.md`.

## Part 1 — Audit of what actually exists (2026-10-07, @ 363efb7)

### 1. Completed systems (verified working)
- Real ingestion → storage (`storage.ts`, containment-safe, Windows-tested),
  ffmpeg/ffprobe validation (`audio.ts`), SHA-256 checksums, waveform jobs.
- Separation worker (Demucs), source/section/event/harmony/drum/vocal
  analysis (9 BullMQ queues; `waveyard-worker/` 6.5k lines, doctor.ts honest
  capability), honest queue-unavailable degradation.
- Arrangement: clips, loops, slicing, beat alignment, cross/multi-source
  placement, meeting points, automatic remix (evidence-based), versions,
  exports (wav/midi), publication/moderation, Arena handoff.
- Mixer basics: volume/pan/mute/solo per stem track — **persisted**
  (`remix_tracks.volume/pan/muted/solo`, `remix_sessions.masterVolume`),
  autosaved (700 ms debounce) and hydrated on load. Automation lanes exist
  for volume/pan (validated, linear, capped at 1024 points).
- Job status model already matches the queue-UI vocabulary exactly
  (`queued/preparing/processing/finalizing/complete/failed/cancelled`).

### 2. Partially implemented
- Transport: Web Audio graph (MediaElement→Gain→StereoPanner→masterGain)
  with drift correction, honest about not being sample-locked. No meters,
  no phase/mono, no buses, no inserts, no analyser taps.
- Master: a bare gain value; no master channel concept, no metering.

### 3. Data model exists, UI missing
- Automation parameters beyond volume/pan (types reserve extension).
- `advanced` processing concepts in analysis payloads; `EditRecipe`-style
  reserved blocks in adjacent rooms (LUMA lesson: engine ahead of room).

### 4. UI exists, processing shallow
- StemMixer is a slider row (no console semantics, no identity display
  beyond labels, no meters, no groups/buses).

### 5. Infrastructure exists, not exposed
- `checksumFile` (provenance!), ffprobe metadata, waveform peaks at 5
  resolutions, `processing_jobs` rows with per-job detail — none surfaced
  as a provenance/diagnostics view. Analysis data (tempo/key/sections/
  events) reaches some panels but not the mixer/AI context.

### 6. Implied by architecture, unfinished
- A processing graph: clips→tracks→(bus)→master→export is the natural
  completion of remix tracks + automation + export jobs.
- Worker-side analysis → AI: the analysis tables are exactly the
  authoritative evidence an AI mix assistant needs; no consumer exists.

### 7. Professional workstation gaps (the P1 list)
Console channel model (SOURCE/STEM/BUS/MASTER), trim, phase, mono
monitoring, meters (peak/RMS/LUFS/clip), insert FX chain (EQ/comp/gate/
saturation/delay/width…), cleanup/repair workflow, loudness measurement,
true-peak awareness, reference comparison, visible automation, clip gain.

### 8. AI assistance opportunities
Mix/master/cleanup assistants that consume *measured evidence* (meters +
band energies + analysis tables) and produce *validated proposals* applied
transactionally. Sound-design recipes rendered by real DSP chains.
Arrangement intelligence on top of the existing automatic-remix engine.

### 9. Windows desktop opportunities
Offline render in worker (no UI-thread DSP), native pickers/drag-drop into
the real ingestion pipeline, background jobs + notifications, reveal
exports in Explorer, autosave/crash recovery, bundled ffmpeg.

### 10. Material improvements that are NOT feature soup
Measurement honesty (LUFS/true-peak everywhere), mixer state versioning,
provenance views, one coherent mode bar (PLAY/STUDIO/MIX/CLEANUP/AI/
DESIGN/EXPORT) instead of new pages.

## Part 2 — Priorities

- **P0 (core correctness):** engine-layer mixer model (kinds, trim/fader/
  pan/phase/mono, bus routing, serialization, legacy adapters), insert
  chain with *real* DSP kernels, measurement core (peak/RMS/crest/DC/clip/
  correlation/LUFS BS.1770-4/true-peak), AI proposal contract (validate →
  clamp/reject → transactional apply → undo). **[this increment]**
- **P1 (professional workflow):** console UI over the engine (groups, buses,
  master section, meters from real AnalyserNode taps), transport upgrade
  (phase/mono/inserts via Web Audio or OfflineAudioContext render),
  cleanup SCAN/PREVIEW/APPLY workflow, clip gain/fades, visible automation.
- **P2 (AI engineering):** analysis packet → provider adapters with honest
  hearing capability (AUDIO_MODEL / AUDIO_DERIVED / TEXT_ONLY), mix/master
  assistants producing proposals, project memory (structured, inspectable).
- **P3 (creative):** sound-design primitives (osc/noise/sweeps — real
  rendered DSP), AI transition designer on section/beat evidence.
- **P4 (optional):** reference-track analysis, spectrum/stereo-field
  displays, oscilloscope, presets marketplace, stem freeze.

## Part 3 — This increment (P0 engine, all pure + tested)

New modules (no existing code touched; additive by design):

- `src/lib/waveyard/mixer/types.ts` — SOURCE/STEM/BUS/MASTER channel strips,
  versioned `waveyard-mixer-v1` state, legacy adapters for the existing
  `remix_tracks` volume/pan/muted/solo columns.
- `mixer/gain.ts` — authoritative gain/pan/phase/mono/solo/bus math shared
  by UI, transport, and offline render. Constant-power pan, trim→fader→pan
  cascade, topological bus order (cycles rejected).
- `mixer/dsp.ts` — real kernels on interleaved PCM: RBJ biquads (LP/HP/
  peaking/shelf/notch), compressor, gate, tanh saturation/soft-clip,
  stereo width (mid/side), feedback delay, dry/wet.
- `mixer/meters.ts` — peak, RMS, crest, DC offset, clipped-region and
  silence detection, stereo correlation/width, band energies, LUFS
  integrated/short-term (ITU-R BS.1770-4 K-weighting + gating), true peak
  (4× oversampled). Calibrated against the EBU R128 anchor
  (dual-mono 1 kHz sine at −23 dBFS RMS/chan ⇒ −23 LUFS).
- `mixer/inserts.ts` — processor registry (zod-validated params), chain
  add/remove/move/bypass, serializable + versioned, `processWithChain`
  using the same kernels the offline render will use.
- `mixer/presets.ts` — real parameter recipes (vocal clarity, drum punch,
  mono-safe, master clean…).
- `measure/cleanup.ts` — SCAN report from actual PCM: clipped regions, DC
  offset, noise floor, hum (Goertzel 50/60 + harmonics), HF noise share,
  rumble share, sibilance share, stereo imbalance/correlation, loudness vs
  target. Every number measured; nothing inferred here.
- `ai/capability.ts` — honest hearing model + exact UI labels.
- `ai/packet.ts` — `waveyard-analysis-packet-v1` built from real
  measurements + analysis tables (waveform/spectral summaries, tempo, key,
  sections, stems, selection, confidence).
- `ai/proposal.ts` — AIProposal zod contract, validator (unknown
  target/processor rejected; out-of-range clamped or rejected, recorded),
  transactional apply returning next state + undo record. Mixes state only
  — source assets are unreachable by construction (Part 18/25/27).

Tests: pan law, gain cascade, solo/mute/phase/mono, biquad attenuation,
compressor/gate/saturation behavior, LUFS calibration, clipping/DC/hum
detection on synthesized fixtures, insert order/bypass/serialization, bus
routing + cycle rejection, legacy round-trip, proposal validation/clamping/
transactionality/undo, capability labels, packet build. Synthetic fixtures
only (legal, deterministic).

## Part 4 — Sequencing after this increment

1. P1 console UI + transport meters (AnalyserNode taps) + phase/mono.
2. P1 cleanup workflow UI (SCAN/PREVIEW/APPLY) on `measure/cleanup.ts`;
   repair ops as worker jobs producing derived artifacts (never overwrite).
3. P2 AI adapters (chat providers → packet; capability model surfaced).
4. P1 clip gain/fades + visible automation lanes.
5. P3 sound-design primitives + transition designer.
6. Desktop Phase 2 (Electron embeds server w/ health handshake) — per the
   Windows program plan — rides alongside; Waveyard processing moves to
   worker/desktop render paths so the UI thread never blocks.

---

## Part 5 — Engine increment results (2026-10-07, verified)

Gates: tsc clean · **332/332 tests** (59 new) · build clean (zero warnings,
from scratch) · desktop shell still compiles. Nothing existing was
modified — all new modules, additive by design.

Calibration anchors the engine is verified against:
- LUFS: dual-mono 1 kHz sine at −23 dBFS peak ⇒ **−22.993 LUFS**
  (spec-exact BS.1770-4 coefficients at 48 k; RBJ prototype + honest
  `kWeightingSource` field at other rates). Full-scale ⇒ +0.007 LUFS.
  Silence ⇒ `null`, never a fabricated number.
- True peak: genuine 4× polyphase sinc oversampling; 16 kHz sine @48 k
  shows the real +1.38 dB inter-sample peak.
- Hum: fine-grained mains-family scan (±2 Hz around 50/60/100/120/150/180)
  with Goertzel contrast vs neighboring tones — 58 Hz detected at −40 dB
  under quiet noise.

Bugs found in my own code BY the tests during this increment (kept as
regression coverage): biquad Q/gain parameter conflation (shelves were
designed with the gain value as Q), shared biquad state corrupting the
band-energy cascade, an inverted bus topological order, a /N² Goertzel
normalization, and — the meta-lesson — parallel same-file edits race
(last write clobbers). The zero-state biquad transient finding is real
filter behavior and is now encoded as a test: a soft ceiling only
guarantees the final peak when the clipper runs LAST.

Next (P1 console): the UI half — channel strips, buses, meters from real
AnalyserNode taps, phase/mono in the transport, cleanup SCAN/PREVIEW/
APPLY, then the AI adapters consuming the packet + proposal contract.
