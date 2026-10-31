---
name: Waveyard CPU separation profiling
description: Performance findings and profiling priorities for local four-stem CPU separation.
---

On 2026-10-31, an 8-second real-audio excerpt on a four-CPU Linux runtime took 95 seconds with three ONNX threads. Two intra-op threads plus reusable FFT scratch took 65 seconds; one thread took 71 seconds. Parallel graph mode with one intra-op and two inter-op threads took 56–58 seconds, with a 84–91 ms playback-timer gap. After scratch reuse, model inference remained the largest stage. Windows stays sequential because its DirectML path has not been tested with parallel graph mode.

**Why:** Production-worker measurements showed both CPU oversubscription and per-frame FFT scratch allocation were affecting the experience. Bounded parallel graph execution further improved this Linux CPU run, but should not be applied to the unverified Windows DirectML path.

**How to apply:** Use parallel graph mode on the measured Linux CPU path, with bounded intra/inter-op threads; keep Windows sequential until tested with DirectML and CPU fallback. Inspect stage reports before tuning further. These measurements prove output integrity, not subjective separation quality or Windows performance.

Four-stem progress is not a reliable whole-job percentage when model passes take unequal time. Show the active pass and chunk instead of presenting equal model shares as elapsed progress.

**Why:** On the measured excerpt, individual passes ranged from about 7 to 27 seconds; a fixed percentage per model would overstate or understate the remaining wait.

**How to apply:** For multi-model separation, show the current stem pass and its chunk count. Keep percentage progress only for single-pass jobs unless duration-weighted estimates are measured and validated for that runtime.
