# ADR-007 — The deep separation engine bridge (A7)

Status: **accepted, implemented and tested** (2026-10; the engine-quality
verification on real music remains an owner-machine acceptance item).
Scope: the second separation engine — the deep pass — and every call this
slice made on the owner's behalf while wiring it.

## Context

The stem machine shipped with one engine: the in-process MDX-Net models
(`separation/mdx.ts`, `worker-local/separation.ts`) — zero setup, no Python,
2 stems (Kim Vocal 2) or the 4-stem recipe. The vision's own promise is
"swappable models — quality improves as software" (vision §Principles 5),
and the owner has now *prepared* a deeper engine on the machine (Demucs, via
their own Python install). "Deep separation" needs to run when — and only
when — that preparation exists, without inventing a second pipeline for it.

## Decisions

### D1 — The deep pass IS the owner's Demucs install; nothing is bundled

`htdemucs_6s` produces six sources: vocals, drums, bass, guitar, piano,
melody. Guitar and piano are lanes no MDX model in the registry can produce.
The app does not bundle PyTorch/Demucs (≈800 MB; the desktop roadmap's
Phase 4 provisioning question stays open) and does not fabricate anything:
it discovers the prepared interpreter and runs it.

### D2 — Interpreter resolution is explicit-first

`WAVEYARD_DEEP_PYTHON` (the owner-prepared install) → `PYTHON_BIN` (the same
override the Python worker honours) → the platform's usual names
(`py -3` then `python` on Windows; `python3`, `python` elsewhere). Probe and
run always use the SAME resolved interpreter.

### D3 — The probe is cheap and sync; the run is async and streams progress

- `probeDeepEngine()` asks the interpreter's **package metadata** for
  Demucs' version (`importlib.metadata`) — no torch import, ~100 ms, cached
  per interpreter set. Routes and intake may call it synchronously to gate a
  request.
- `runDeepSeparation()` spawns the engine **asynchronously** and parses its
  own percent off stderr into the job row's metadata (the same contract the
  MDX path keeps). *Deliberate deviation from the earlier sketch of a fully
  synchronous bridge:* the local worker drains jobs inside the app's own
  server process (`src/instrumentation.ts`), so a `spawnSync` deep run would
  block every HTTP request — and every status poll the UI needs — for the
  whole multi-minute pass. The seam the handler needs stays a single function
  (`SeparationHandlerDeps["runDeep"]`), so tests still drive it with a stub.

### D4 — The deep pass rides the existing durable pipeline

One `processing_jobs` row, the same `enqueueSeparation` payload, the
handler's deep branch before the registry lookup, the shared stem-creation
tail (encode → checksum → storage → insert → per-stem waveform jobs), and
the same layer naming. No parallel persistence, no second queue, no new
tables, no migration.

### D5 — Naming and depth

Whole-source deep pass → six top-level lanes. Deep pass on a stem → layers
(`<parent>/<child>`, e.g. `other/guitar` = guitar inside the melody).
Layering a layer stays refused (one level deep), exactly as stem-layers
already did.

### D6 — Offered always, refused honestly before any work is queued

The mode appears in the intake selects and as a per-lane deck chip. If the
machine is not prepared: the upload route refuses before a byte is stored
(503 + the exact prepare step), the deep route refuses before a job row
exists, and the handler's own run still fails to `separation_unavailable`
if preparation disappears mid-queue. External-worker and no-processor
runtimes report that the deep pass is an in-process feature rather than
probing for an engine they would never run (`deepEngineStatusForThisRuntime`).

### D7 — A deep pass never deletes shallower stems

The tempting "go deeper = replace the fast pass" is unsafe: arrangement
tracks reference stems with `onDelete: "restrict"` (`remix_tracks.stem_asset_id`),
so deleting an in-use stem would either abort the job's transaction or
destroy arrangement state. Deep separation is therefore ADDITIVE and the
navigation is lane-scoped: new uploads may target `deep_6s` directly, and an
existing song goes deeper per lane. If the owner later wants whole-song
replacement, the honest form is an explicit "replace lanes" action that
records what it superseded — not an implicit side effect of going deeper.

### D8 — Verification

- `separation/deep.test.ts` — stub "python" drivers (real executables, real
  spawn): probe prepared/unprepared + caching + interpreter precedence, the
  exact Demucs contract asked for, device resolution, engine-progress
  forwarding, and every honest failure (no Demucs, missing/empty output,
  non-zero exit, CUDA requested without CUDA).
- `worker-local/separation.test.ts` — the handler's deep branch: a full run
  through the REAL bridge with the stub engine (six attributed stem rows,
  `htdemucs_6s@demucs-…` provenance, waveform jobs), deep layers named
  `<parent>/<child>`, the honest unavailable path (nothing stored), and an
  injected-seam test that proves the engine input is the handler's decoded
  44.1 kHz stereo WAV and that stored lanes are exactly the engine's output
  (SNR-checked), with no MDX engine opened.

## Consequences

- Deep separation now works end to end on any machine where the owner ran
  `pip install demucs`. Quality, level and timing on real music are the
  owner-machine acceptance items that remain (as with the MDX models).
- The app never claims a six-source result it did not compute: every deep
  stem row records `engine: "demucs"`, `model: "deep_6s"` and a modelVersion
  pinning the family + engine version.
- Follow-ups deliberately not taken here: in-app Demucs provisioning (desktop
  roadmap Phase 4), a server-worker Demucs adapter that accepts `deep_6s`,
  24-bit/float output handling (the pipeline stores 16-bit PCM), and any
  "replace lanes" affordance (see D7).
