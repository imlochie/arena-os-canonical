---
name: Waveyard CPU separation profiling
description: Performance findings and profiling priorities for local four-stem CPU separation.
---

On 2026-10-31, an 8-second real-audio excerpt on a four-CPU Linux runtime took 95 seconds with three ONNX threads. Two intra-op threads plus reusable FFT scratch took 65 seconds; one thread took 71 seconds. Parallel graph mode with one intra-op and two inter-op threads took 56–58 seconds in that earlier run. A later same-machine, same-excerpt comparison measured sequential 2/1 at 40.7–41.3 seconds, parallel 1/2 at 52.2 seconds, and parallel 1/1 at 55.3 seconds. Playback timer gaps were 52–72 ms and all outputs passed PCM integrity checks. Keep Linux sequential by default; parallel remains opt-in because results vary by input and runtime. Windows stays sequential because its DirectML path has not been tested with parallel graph mode.

A paired 2-second real-audio excerpt on the same four-logical-CPU Linux runtime, using two repetitions per setting, measured sequential 2/1 at 28.7–29.2 seconds and parallel 1/2 at 36.2 seconds. Playback timer gaps were 43–56 ms sequential and 47–54 ms parallel. This short CPU-only run reinforces the sequential default but should not be generalized to longer excerpts or Windows/DirectML.

**Why:** Production-worker measurements showed both CPU oversubscription and per-frame FFT scratch allocation were affecting the experience. Results from the same Linux runtime varied substantially across measurement runs and real excerpts, so the newer paired run should guide the default for that four-CPU scenario without treating parallel mode as a general speedup.

**How to apply:** Use sequential graph mode by default and keep parallel available only as an explicit, measured override; keep Windows sequential until tested with DirectML and CPU fallback. Inspect stage reports on the actual input before tuning further. Linux measurements prove output integrity, not subjective separation quality or Windows performance.

Four-stem progress is not a reliable whole-job percentage when model passes take unequal time. Show the active pass and chunk instead of presenting equal model shares as elapsed progress.

**Why:** On the measured excerpt, individual passes ranged from about 7 to 27 seconds; a fixed percentage per model would overstate or understate the remaining wait.

**How to apply:** For multi-model separation, show the current stem pass and its chunk count. Keep percentage progress only for single-pass jobs unless duration-weighted estimates are measured and validated for that runtime.

On 2026-11-01, seven consecutive pinned four-model jobs on the same 8-second, 44.1 kHz stereo real excerpt completed on a four-logical-CPU Linux host. With explicit GC, post-job RSS was 724.5, 868.4, 860.1, 1020.5, 1020.2, 1019.4, and 1024.9 MiB from a 625.8 MiB baseline. The first three jobs retained 234.3 MiB; RSS rose further on job four, then the final-half median was 1022.2 MiB, only 1.7 MiB above the first steady sample. Post-job JS heap stayed between 25.0 and 25.5 MiB, external memory between 267.0 and 271.2 MiB, and array buffers at 58 MiB. A mid-run active-inference spot check read 3377 MiB RSS; it was not a peak measurement.

**Why:** Repeated real excerpts show a substantial one-time native/allocator warm-up followed by a plateau, while post-GC JS heap stayed flat. Active inference can consume much more memory than post-job samples, which matters on constrained laptops.

**How to apply:** Treat this as Linux CPU evidence for an 8-second excerpt only. Continue measuring active peaks and Windows separately; do not infer Windows/DirectML memory from this plateau.
