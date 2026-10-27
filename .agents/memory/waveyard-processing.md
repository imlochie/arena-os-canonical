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

Treat a physical playback deck's audio graph as longer-lived than its selected song, and bind media source nodes to actual media elements rather than asset identifiers alone.

**Why:** HTML media time can advance even when its Web Audio graph is closed or disconnected. Element volume is not proof that gain, mute, or solo still works.

**How to apply:** Recheck actual graph state and gains when changing/revisiting songs. Swapping a media URL also resets its clock/play state, so verify clock alignment and resumed playback, not just a successful saved swap record.

Live stem swapping must leave the recipient's transport clock independent of its audible layers. Prepare replacements while the existing layer remains audible, then blend only that channel; restoring Original must not restart the song.

**Why:** The user wants stem.fm-style live swapping, not a separate remix step. Replacing a playing media URL interrupts that layer, and using a short donor as the deck clock breaks all-layer swaps.

**How to apply:** Exercise independent donors, all four layers replaced, short donors, failed/late downloads, and pause/seek/resume. Verify actual signal routing and gain changes, not only source labels or saved records.
