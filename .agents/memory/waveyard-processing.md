---
name: Waveyard processing evidence
description: Real-model verification and memory constraints for the local audio pipeline.
---

Verify an actual uploaded audio file through inference and persisted playable outputs before claiming stem processing works. Configuration policy and checksum-ready models prove neither executor startup nor native runtime resolution.

**Why:** Declared processing policy, installed dependencies, and related-model parameter tables can disagree with what the running service can execute.

**How to apply:** Check the running process's registered handlers, use the actual service package's resolution context for external native dependencies, and inspect each pinned ONNX file's input shape rather than inferring it from related models.

Keep only one native separation model open at a time and bound its CPU threading/memory allocation.

**Why:** Native inference arenas can retain far more memory than the weights themselves, so holding several models risks terminating the entire API.

**How to apply:** Preserve sequential session lifetime, release on errors too, and measure real full-song memory/performance before increasing parallelism. A short synthetic musical fixture establishes pipeline execution, not subjective separation quality.

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
