---
name: Waveyard processing evidence
description: Real-model verification and memory constraints for the local audio pipeline.
---

Verify an actual uploaded audio file through inference and persisted playable outputs before claiming stem processing works. Configuration policy and checksum-ready models prove neither executor startup nor native runtime resolution.

**Why:** Declared processing policy, installed dependencies, and related-model parameter tables can disagree with what the running service can execute.

**How to apply:** Check the running process's registered handlers, use the actual service package's resolution context for external native dependencies, and inspect each pinned ONNX file's input shape rather than inferring it from related models.

Keep only one native separation model open at a time and bound its CPU threading/memory allocation.

**Why:** Native inference arenas can retain far more memory than the weights themselves, so holding several models risks terminating the entire API.

**How to apply:** Preserve sequential session lifetime, release on errors too, and measure real full-song memory/performance before increasing parallelism. Keep native arena and memory-pattern caching disabled unless new target-device evidence justifies enabling them: real short excerpts repeatedly exhausted the hosted memory limit with those caches enabled, including without the database fixture, while the same pinned models completed with both disabled. Small model-file sizes are not a reliable inference-memory budget. A short synthetic musical fixture establishes pipeline execution, not subjective separation quality.

Deep subprocess cancellation must own one process group per attempt, stop descendants as well as the Python parent, and wait for confirmed exit before the job becomes terminal. Remove only that attempt's unpublished temporary outputs.

**Why:** Killing only the parent can leave a child writing into output folders after the UI reports a stop, while an unsafe cleanup can damage the original track, prior stems, or saved session references.

**How to apply:** Isolate each external engine run in its own process group, escalate termination only within that group, propagate the broker abort signal, and verify source bytes, prior outputs, session pointers, and a clean retry after cancellation.

Treat a live stem-layer instance as terminal once disposed. Abort signal-aware downloads and tempo work, but still check after non-cancellable decode/worklet awaits before installing audio or retaining buffers.

**Why:** `decodeAudioData` cannot be aborted, and worklet setup can complete after the session closes; removing cache entries alone does not prevent late playback or orphaned sources.

**How to apply:** Set the terminal flag before aborting pending work, guard new operations, validate ownership after awaits, and stop deferred/retired engines during disposal.

For retry evidence, exercise the default local queue handoff into the production separation handler; a custom retry callback bypasses the broker wiring used by the library.

**Why:** A real model can complete successfully when called directly even if the user-facing retry path fails to enqueue or route its job.

**How to apply:** Assert the retried durable row completes and its stem objects are persisted after the local broker drains. Keep CPU timing separate from Windows or separation-quality claims.

Do not chase separation speed by weakening model verification or opening multiple native sessions without target-device measurements.

**Why:** A Linux CPU timing showed model checksum verification and session creation were a small fraction of the four-model run; inference dominated. That does not establish Windows throughput or justify increasing memory pressure.

**How to apply:** Profile the actual inference on the intended machine and real audio before changing checksum guarantees, session lifetime, or concurrency.

In the Replit Linux runtime, ONNX Runtime may log a missing shared CUDA provider library before successfully falling back to CPU.

**Why:** A passing run after that warning proves the CPU fallback, not that CUDA or any Windows execution provider works.

**How to apply:** Read the resolved device from the completed job and keep the provider warning distinct from inference failure; do not treat the Linux fallback as target-device evidence.

Treat a physical playback deck's audio graph as longer-lived than its selected song, and bind media source nodes to actual media elements rather than asset identifiers alone.

**Why:** HTML media time can advance even when its Web Audio graph is closed or disconnected. Element volume is not proof that gain, mute, or solo still works.

**How to apply:** Recheck actual graph state and gains when changing/revisiting songs. Swapping a media URL also resets its clock/play state, so verify clock alignment and resumed playback, not just a successful saved swap record.

Live stem swapping must leave the recipient's transport clock independent of its audible layers. Prepare replacements while the existing layer remains audible, then blend only that channel; restoring Original must not restart the song.

**Why:** The user wants stem.fm-style live swapping, not a separate remix step. Replacing a playing media URL interrupts that layer, and using a short donor as the deck clock breaks all-layer swaps.

**How to apply:** Exercise independent donors, all four layers replaced, short donors, failed/late downloads, and pause/seek/resume. Verify actual signal routing and gain changes, not only source labels or saved records.

Use the built API in an isolated child process for whole-stack CPU-load evidence, with private database, storage, models and port settings.

**Why:** Direct database probes and manually invoked handlers bypass production routing, desktop host checks, serialization and worker startup. Those boundaries are part of a usable desktop application.

**How to apply:** Probe valid response bodies throughout each real model pass with explicit deadlines. Retain long-running acceptance logs under the ignored workspace output directory so a workspace restart cannot erase the evidence. Synthetic Linux responsiveness evidence is not full-song throughput, audio quality or Windows proof.

Do not treat non-zero stems, correct layer gains, or advancing clocks as proof of an audible or musically successful live swap. Reject an effectively silent donor before takeover and preserve the currently audible layer; report low-energy stems separately from file-integrity checks.

**Why:** Real remix vocal estimates passed a `>-90 dBFS` non-silence check while measuring roughly `-64` to `-70 dBFS`, so the browser routing test passed without a meaningful vocal change.

**How to apply:** Measure bounded RMS during donor preparation, apply the same audibility floor in real-audio reports, and keep routing evidence separate from human A/B quality checks.

For automatic stem swaps, treat a near-2:1 BPM estimate as a possible half/double-time interpretation, not an instruction to stretch the donor vocals by 2×. Keep the donor at its native pace and label that choice; reserve large warps for an explicit manual action.

**Why:** A low-confidence real-track estimate triggered a half-duration vocal warp that sounded unusable even though the browser routing test passed.

**How to apply:** Keep the automatic tempo policy separate from the engine's wider processing limits, and verify that the picker and saved-swap status clearly distinguish native pace from a true tempo stretch.

Treat full-track tempo as a consensus across local windows, not one global autocorrelation peak. Fold clear half/double-time readings into a common DJ range, lower confidence when windows disagree, and treat generated grid regularity as no evidence of audio alignment. Only current-version tempo confidence may authorize automatic stretching; beat alignment needs measured onset-to-grid fit, and stale beat grids must not drive automatic cues.

**Why:** Real uploaded mixes produced confident-looking but contradictory local tempo readings, including half-time and double-time peaks. A grid derived from an estimate is evenly spaced by construction, so regularity alone can falsely imply synchronization.

**How to apply:** Keep BPM and beat-fit confidence separate in swap logic and labels; version-gate both metrics and grids at session/library boundaries; preserve native donor pace when current tempo evidence is weak.

Key confidence must measure both profile fit and the margin over competing key profiles; a strong single chord can fit several keys and is not a confident song-key estimate.

**Why:** Treating the winning profile score alone as confidence made ambiguous material look certain, which can produce misleading Camelot guidance or automatic pitch correction.

**How to apply:** Return no key for uniform chroma, keep ambiguous keys tentative, and only advertise harmonic fit or apply automatic key correction when both tracks have current, sufficiently distinct key evidence. Legacy confidence values from an older algorithm version must not be treated as current.

Never treat the same section index in two tracks as evidence that the musical roles match. Cross-track phrase alignment requires the same confidently detected structural role; generic novelty cuts must fall back to beat-phase alignment.

**Why:** Equal section counts and ordinal positions can occur in unrelated arrangements, so mapping section 2 to section 2 can sound like a random jump while appearing structurally precise.

**How to apply:** Preserve role labels and label confidence through analysis and UI boundaries, accept only comparable labels such as verse/chorus with strong confidence, and choose among repeated instances by relative position and duration.

Local onset analysis can identify repeated rhythmic fingerprints, but that is within-track evidence only—not a verse/chorus label or proof that two songs have corresponding sections.

**Why:** A repeated drum pattern can occur under different harmony and arrangement roles, so using it alone for cross-track swaps could recreate the abrupt, musically mismatched results the user rejected.

**How to apply:** Display rhythmic repeats as such, retain their measured similarity score, and keep live cross-track section alignment disabled unless both tracks have comparable high-confidence structural roles.

An automatic hybrid must contain at least one real donor stem; never save an anchor-only fallback under a hybrid label.

**Why:** A nominally successful hybrid that reuses only the anchor misrepresents what Waveyard actually produced and erodes trust in its musical intelligence.

**How to apply:** Require current tempo, key, beat, and comparable-role evidence before selecting a donor. If no donor passes, return a specific failure and keep the faithful original option available rather than persisting a mislabeled hybrid.
