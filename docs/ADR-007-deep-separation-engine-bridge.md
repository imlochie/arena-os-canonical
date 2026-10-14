# ADR-007 — The deep separation engine bridge (A7)

Status: **accepted, implemented and tested** (2026-10; amended after the A7
code review — see the "Review follow-up" entries below. The engine-quality
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
other (the residual — everything the five named sources did not claim; it
is shown as **Other**, not Melody: the MDX `other` lane is the melody bed
of a 4-stem recipe, the deep `other` lane is what is left after guitar and
piano were taken out as well). Guitar and piano are lanes no MDX model in
the registry can produce. The app does not bundle PyTorch/Demucs (≈800 MB;
the desktop roadmap's Phase 4 provisioning question stays open) and does
not fabricate anything: it discovers the prepared interpreter and runs it.

### D1a — Review follow-up: the model weights are a LOCAL checkpoint, never a download

Demucs resolves a model *name* against its remote weight store and
downloads on first use. The app never triggers that: the bridge runs the
engine with `--repo <WAVEYARD_MODELS_DIR>` and the checkpoint's own
**signature** (`--name 5c90dfd2`), which makes Demucs load
`5c90dfd2-34c22ccb.th` from the app's models directory and verify its
checksum itself — the same directory, and the same "the owner places the
file" step, as the MDX models. `htdemucs_6s` is exactly the one-model bag
`['5c90dfd2']`, so the result is the six-source model, not a lookalike. The
checkpoint is part of readiness: Demucs installed but no checkpoint ⇒ not
prepared, with the exact configured path in the reason (the probe, the run
and the prepare hint all resolve the models dir from the SAME environment —
an injected env in tests, `process.env` in production — so the reported
path is always the one that was checked). The interpreter probe is cached;
the checkpoint is re-checked on every readiness query, so placing the file
flips the deep pass to ready without a restart.

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
tables.

### D4a — Review follow-up: one ACTIVE job per target, not one job ever

The first cut keyed the deep job `separation-deep:<target>` against the
whole-key unique index and used `onConflictDoNothing` → the second request
for a target was a 409 **forever**, including after the job had completed or
failed (the same latent defect existed in the sibling `stem-layers` route).
The rule is now "one *active* attempt per target": the uniqueness lives in
a partial unique index over non-terminal rows
(`processing_jobs_active_idempotency_unique`, migration
`desktop-migrations/0015` / `drizzle/0022`, which also drops the old
whole-key index), and `separation/claim.ts` inserts with the index's own
predicate in `ON CONFLICT … WHERE … DO NOTHING`. Consequences:

- a repeat request while an attempt is queued/running is an honest 409 that
  names the holding job;
- once that attempt is complete, failed or cancelled, the same target can be
  run again as a **fresh row** — earlier attempts stay as history;
- concurrent requests are arbitrated by PostgreSQL, not by a
  select-then-insert in the route (proved against the real embedded cluster
  with 16 simultaneous claims);
- the same-row retry path (`separation/retry.ts`, `/api/jobs/[id]/retry`)
  claims the key by resetting the failed row FIRST (a `unique_violation`
  means a newer attempt already holds the target → refused with that
  reason), only then hands the job to an executor, and restores the row
  exactly if that hand-off fails; a retried layer job carries its
  `parentStemAssetId` again. Both runtimes go through the same function in
  the same order — the server route passes BullMQ's `queueJob.retry()` in
  as the hand-off instead of asking BullMQ before the row is claimed, so a
  retry can never be triggered for a target another request just took;
- a claimed row is released if the queue refuses it: `startSeparationJob`
  (the routes' whole start step) records the row as a failed, retryable
  `queue_unavailable` attempt and answers 503, instead of a 202 over a
  `queued` row that nothing will run. There is no background sweep that
  would rescue such a row, and under the active-only index it would have
  held the target's key forever — in the `external` / `none` processing
  modes that was a permanent 409 after one failed request.

### D5 — Naming and depth

Whole-source deep pass → six top-level lanes. Deep pass on a stem → layers
(`<parent>/<child>`, e.g. `other/guitar` = guitar inside the melody lane).
Layering a layer stays refused (one level deep), exactly as stem-layers
already did. Lane labels come from one helper (`separation/stem-display.ts`):
an `other` stem reads **Melody** when the MDX engine produced it and
**Other** when the deep engine did, and a layer is named by the engine that
produced each segment.

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

### D8 — Verification (and what is explicitly NOT verified)

- `separation/deep.test.ts` — a REAL Python interpreter driving a FAKE
  Demucs (`deep-fixtures.ts`: fake `demucs`/`torch` packages and package
  metadata on an isolated `PYTHONPATH`, every invocation logged, works on
  Windows too) through the bridge's real spawn: probe not-installed /
  installed-without-checkpoint / prepared, caching with a live checkpoint
  check, interpreter precedence, the exact Demucs contract asked for
  (`--repo <models dir> --name 5c90dfd2`), the provenance string, device
  resolution, engine-progress forwarding, and every honest failure (no
  Demucs, no checkpoint with the exact configured path, a checkpoint Demucs
  refuses, missing/empty output, non-zero exit, CUDA requested without
  CUDA). Skipped visibly on a machine without Python 3.
- `worker-local/separation.test.ts` — the handler's deep branch: a full run
  through the REAL bridge with the stand-in engine (six attributed stem
  rows, `htdemucs_6s@5c90dfd2-34c22ccb/demucs-…` provenance, waveform
  jobs), deep layers named `<parent>/<child>`, the honest unavailable path
  (nothing stored), and an injected-seam test that proves the engine input
  is the handler's decoded 44.1 kHz stereo WAV and that stored lanes are
  exactly the engine's output (SNR-checked), with no MDX engine opened.
- `separation/claim.test.ts` — the one-active-job rule on PGlite (409 while
  active, fresh row after complete/failed/cancelled, the index refuses two
  active rows by itself); the start step with the local broker (payload
  delivered; a refused queue leaves a failed `queue_unavailable` row, a free
  key, and a retryable attempt — never a stranded `queued` row); and on the
  real embedded PostgreSQL cluster (16 concurrent claims → one job; a retry
  racing a fresh claim in both the local and the server-mode hand-off
  flavour → one active row, and the hand-off runs exactly when the retry
  owns the key, on an already-claimed row). `separation/retry.test.ts` —
  the same-row retry refuses to resurrect a row while a newer attempt is
  active, carries the parent stem, and invokes the server-mode hand-off
  only after the claim. `separation/stem-display.test.ts` — the
  Melody/Other labels, including the parent lookup both playback surfaces
  share (`laneDisplayName`).
- **NOT verified:** real inference. The checkpoint in every test is a dummy
  file and the Demucs is a fake; no six-stem output on real audio has been
  produced or listened to in CI. That — plus the first run of the real
  `5c90dfd2-34c22ccb.th` on the owner's machine (download it from Demucs'
  release store or copy it out of the torch hub cache into
  `WAVEYARD_MODELS_DIR`) — is the owner-machine acceptance step.

## Consequences

- Deep separation now runs end to end on any machine where the owner ran
  `pip install demucs` AND placed `5c90dfd2-34c22ccb.th` in
  `WAVEYARD_MODELS_DIR` (the readiness surfaces — deck chip, intake, models
  route, diagnostics — name the exact missing path until then). Quality,
  level and timing on real music are the owner-machine acceptance items that
  remain (as with the MDX models).
- The app never claims a six-source result it did not compute: every deep
  stem row records `engine: "demucs"`, `model: "deep_6s"` and a
  `modelVersion` of the form `htdemucs_6s@5c90dfd2-34c22ccb/demucs-4.0.1`
  — family, the exact checkpoint identity (signature-checksum, derived from
  the same constants the bridge loads with) and the detected engine version.
- Follow-ups deliberately not taken here: in-app Demucs provisioning (desktop
  roadmap Phase 4), a server-worker Demucs adapter that accepts `deep_6s`,
  24-bit/float output handling (the pipeline stores 16-bit PCM), and any
  "replace lanes" affordance (see D7).
