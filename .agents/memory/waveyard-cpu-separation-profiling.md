---
name: Waveyard CPU separation profiling
description: Performance findings and profiling priorities for local four-stem CPU separation.
---

On 2026-10-31, an 8-second real-audio excerpt on a four-CPU Linux runtime took 95 seconds with three ONNX threads. Two intra-op threads plus reusable FFT scratch took 65 seconds; one thread took 71 seconds. Parallel graph mode with one intra-op and two inter-op threads took 56–58 seconds, with a 84–91 ms playback-timer gap. After scratch reuse, model inference remained the largest stage. Windows stays sequential because its DirectML path has not been tested with parallel graph mode.

**Why:** Production-worker measurements showed both CPU oversubscription and per-frame FFT scratch allocation were affecting the experience. Bounded parallel graph execution further improved this Linux CPU run, but should not be applied to the unverified Windows DirectML path.

**How to apply:** Use parallel graph mode on the measured Linux CPU path, with bounded intra/inter-op threads; keep Windows sequential until tested with DirectML and CPU fallback. Inspect stage reports before tuning further. These measurements prove output integrity, not subjective separation quality or Windows performance.
