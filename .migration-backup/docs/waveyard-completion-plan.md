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

---

## Part 6 — Prompt-driven arrangement generation + Voice Studio contracts (2026-10-07)

Two flagship capabilities from the user's request, built on the honesty
discipline (real engine work now; model-gated parts report exactly what
they are):

### Arrangement generation — REAL end-to-end, live-verified
"add some sinister sounding strings on this eminem beat" →
POST /api/waveyard/projects/[id]/arrangement-layers → strings + sinister,
12 chord placements, every start on the analyzed 90 BPM beat grid, every
note diatonic to the analyzed A minor, rendered through the new synth
engine to a real 44.1 kHz WAV (2 MB, peak −3.2 dBFS) in project storage,
with full provenance. GET …/arrangement-layers/[layerId] serves it.

- `mixer/synth.ts` — subtractive synthesis (strings/pad/pluck/choir/
  sub-bass: detuned ensembles, envelopes, per-note filter state, vibrato)
  + 16-bit WAV encode/decode. Tests: silence outside notes, instrument
  envelope differences, velocity scaling, ceiling protection, WAV
  round-trip.
- `arrangement/composer.ts` — ArrangementInstruction (zod) → note events
  from ONLY real evidence (key/tempo/beat grid/sections); refuses to
  compose without them. Mood biases documented (sinister ⇒ parallel
  minor, density ⇒ chords/bar); register anchor snaps to the key tonic;
  seeded deterministic RNG. Tests: diatonic, on-grid, section-scoped,
  density levels, determinism, honest-refusal paths.
- `arrangement/prompt.ts` — deterministic lexicon parser (instrument/
  mood/density/register/section/level words) reporting interpretation +
  used defaults + unmapped phrases; strict AI-instruction validator
  (models emit the same contract; malformed ⇒ rejected, never repaired).
- Route enforces: analysis must be complete (else 409 ANALYSIS_MISSING
  naming what's missing), storage under projects/{id}/generated/, source
  never touched, provenance on every response.

### Voice Studio — contracts + consent gate (execution is model-gated)
- `voicestudio/consent.ts` — ConsentRegistry: identity cloning REQUIRES a
  consent record (own-voice attestation or licensed with concrete rights
  evidence); revocation re-locks instantly; fingerprints for provenance.
- `voicestudio/capability.ts` — honest capability resolution: identity
  conversion (consent + worker + models), style transfer (delivery
  character, identity preserved — no consent needed), pitch correction,
  unavailable (with the exact reason). Exact UI labels.
- `voicestudio/job.ts` — voice-conversion job contract (queue name, model
  kinds, transpose/strength ranges, provenance with consent fingerprint);
  jobs are unbuildable without consent — downstream is safe by
  construction.

Neural execution (RVC/so-vits-svc conversion, autotune rendering) lands
with the worker/desktop phases — the capability surface reports it as
unavailable today, never fake. Gates: tsc 0 · **360/360** · build clean ·
desktop compiles · live E2E verified above.

---

## Part 7 — Finalization increment (2026-10-07): Phase 0 audit + Phase 1 fixes + console UI + real meters

**Phase 0 audit result:** zero TODO/FIXME/stub/noop/"coming soon" markers
in the entire Waveyard surface (lib, components, routes) — the only
matches are legitimate HTML input placeholders. Real findings were the
integration gaps below, categorized P0/P1 and fixed in this increment.

**Fixed — Phase 1.1 (P0, temp-file leak):** the arrangement-layer route
left temp WAVs behind on every non-happy path. All temp handling now runs
through a `finally` block — success, validation failure, storage failure,
render failure, and thrown exceptions all clean up. Live-verified: 0
`arena-layer-*` files in /tmp after generation.

**Fixed — Phase 1.2 (P1, durable layers):** generated layers were
reconstructible from storage keys only. New `arrangement_layers` table
(migration 0011) persists the full record: original prompt, validated
instruction, instrument/mood/density/register/sections/level/seed, note
events, realization + interpretation notes, storage key, renderer,
sample rate, duration, provenance. GET lists durably; DELETE removes row
+ derived WAV (source untouched). **Live-verified surviving a full server
restart** (same layer id, same audio), plus real WAV serve (2 MB,
−3.2 dBFS peak) and honest 409s.

**Phase 2/3 (P1, console + real meters):** StemMixer (slider row)
superseded by MixerConsole — SOURCE-grouped STEM strips + MASTER strip;
fader (dB-labelled), pan, mute, solo, **real phase inversion (negative
gain)** and **mono monitoring (explicit 1-channel downmix)** per channel;
**real meters from AnalyserNode taps** — per-channel peak/RMS/clip-hold,
master L/R + clip + live stereo correlation — polled from the actual
audio graph only while audio flows (no fabricated animation). Every
control modifies the graph; nothing decorative is rendered. Transport
gained per-channel analyser taps + master splitter (L/R) without breaking
the existing API. GeneratedLayers panel (compose prompt → list → play →
inspect notes → delete, with honest empty state) wired into StudioCore.

**Honest remainder (next increments, in priority order):** insert-rack UI
wired to channel persistence (engine + registry exist; needs
remix-track-level insert columns); cleanup SCAN/PREVIEW/APPLY UI over the
real scanner (engine exists); AI provider adapters consuming the packet +
proposal UI (contracts exist); sound-design preset builder; reference/
mastering workflow; automation lane editing UI (engine + persistence
exist).

Gates: tsc 0 · **362/362 tests** · production build clean · live E2E:
generate → 0 temp files → durable across server restart → WAV serve →
delete → honest 409.

---

## Part 8 — Block 2 completion & product freeze (2026-10-07, @ 3b4ea88)

**Verdict recorded:** the Waveyard web product is integration-complete and
**frozen** at `3b4ea88`. Further work moves to the Arena Windows desktop
phase (see `docs/windows-desktop-architecture.md`), which absorbs the
remaining runtime dependencies rather than adding web features.

### What Block 2 delivered (all live-verified, restart-verified)

- **P1 — Insert rack:** per-STEM + MASTER chains persisted in
  `remix_tracks.inserts` / `remix_sessions.master_inserts`
  (waveyard-inserts-v1), validated at the persistence boundary (absent =
  keep, null/[] = clear, invalid = 400); InsertRack UI drives the live Web
  Audio subgraphs (`applyInserts`; gate honestly render-path-only) and the
  persisted chain; mixer presets appendable. Phase inversion (Ø) persisted
  (`remix_tracks.phase_inverted`, 0015); mono monitoring is live-only and
  labelled as such.
- **P2 — Cleanup:** SCAN (measured findings + evidence) → REVIEW
  (recommendations mapped only to real processors, each citing its
  measurement) → PREVIEW (real processed WAV + before/after
  AudioMeasurements, A/B players) → APPLY (derived `cleanup_versions`
  row + WAV, original untouched, undo = delete). Stage chips
  Detected/Recommended/Previewed/Applied make the state explicit; nothing
  implies a repair before Apply.
- **P3 — AI:** 16 workflows; OpenAI-compatible + Anthropic adapters
  (call-time env, honest 503 `PROVIDER_UNAVAILABLE` with the exact reason,
  no canned fallback); prompts state the model did NOT receive audio and
  embed the measured analysis packet; proposals validated by the contract
  (validator is the authority, clamps recorded), applied transactionally
  onto remix persistence with `ai-`-prefixed ids so racks badge AI vs
  manual inserts. ACCEPT re-validates server-side.
- **P4 — Clip editing:** timeline drag/trim/nudge/duplicate/delete +
  inspector clip picker, gain/fade sliders, split-at-playhead, duplicate,
  delete — all persisted paths; inspector follows timeline selection.
- **P5 — Sound design:** 11 deterministic recipes over the real synth +
  insert engines (incl. sample-level reverse/stutter), persisted with full
  recipe provenance, persisted mute, storage-backed WAVs.
- **P6 — Master studio:** measured analysis (LUFS/peak/true-peak/crest/
  correlation/bands + headroom), recommendations only where a measurement
  justifies one (bounded ±12 dB gain — no limiter claims), real-chain
  preview with before/after tables, apply persists the session master
  chain.

### Integration bugs found by the E2E and fixed with regression tests

These are the reason the E2E exists — none surfaced in unit tests:

1. Version snapshots dropped `masterInserts` (track inserts survived via
   row spread; the master chain did not). Fixed via the extracted
   `remix-versioning.ts` contract + 5 regression tests covering TRACK /
   MASTER / combination / save→restore→re-save→export.
2. The AI bridge parsed remix rows with the envelope format while rows
   store the bare-array canonical form → pre-existing chains read as `[]`
   and AI applies REPLACED manual work. Fixed + regression test asserting
   AI applies APPEND.
3. AI provenance re-ided the whole chain (manual inserts badged AI); now
   only inserts created by the apply get the `ai-` prefix.
4. Phase invert was live-only (non-persisting feature = incomplete); now a
   real persisted column end-to-end.
5. Non-UUID clip ids reached PostgreSQL as 22P02 → 500; now clean 404s in
   clips/edit, clips/align-beat, and filtered in batch-edit.
6. Restore dropped both insert chains (fields listed explicitly); restore
   now writes them via the shared contract mapping.

### Final gates at freeze

tsc clean (fresh cache) · **400/400 tests** · production build clean ·
35-step live E2E green (project→import→play→mixer→inserts→persist→scan→
preview→apply→layers→AI (honest 503)→proposal→apply→clip→automation→
master→version→restore→export (honest worker gate)→restart→all state
survived) · render engine signal-verified (hum −34.8 dB @ 50 Hz while the
220 Hz signal moved −0.0 dB; DC 1.50%→−0.00%).

### Roadmap caveat — pinned deliberately

**BUS routing is not persisted as a real subsystem.** The architecture
envisioned SOURCE → STEM → BUS → MASTER; the mixer engine
(`mixer/state.ts`) has the channel kinds and `addBus()`, but the persisted
model is **STEM + MASTER** (strips, inserts, phase, automation, clips,
master chain) and the live transport wires stems → master only. There is
no persisted bus graph, no bus routing table, and no bus-level insert
persistence. Any future bus work is a **deliberate new subsystem** — not a
bug, not a quick fix — and must not be forgotten when the desktop phase
revisits the routing story.

### Runtime dependencies at freeze (honest, not bugs)

- **Redis + waveyard-worker** — export/separation/analysis rendering is
  worker-gated; API returns honest 503 + `queue-unavailable` job rows.
- **ffmpeg** — native 16-bit WAV decode needs nothing; compressed formats
  return 424 `DEPENDENCY_MISSING` naming the exact gap.
- **AI provider keys** — none configured; 503 with the exact reason, zero
  fake fallback, all non-AI features unaffected.

The Windows desktop phase (Arena.exe supervising the Next UI, embedded
Postgres, bundled FFmpeg/FFprobe, a supervised local worker, optional AI
providers, offline-capable core) is the intended answer to all three —
not more web-side feature work.
