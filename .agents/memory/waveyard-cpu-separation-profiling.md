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

On 2026-11-03, six pinned four-model jobs on one 20-second, 44.1 kHz stereo excerpt increased post-release RSS from 620.4 MiB to 715.6, 874.0, 953.2, 1056.5, 1041.5, and 1074.8 MiB. The first three jobs retained 332.7 MiB; final-half median RSS was 1058.1 MiB, only 1.6 MiB above the first steady sample. Post-GC heap stayed at 25.8–26.1 MiB, external memory at 296.8–303.6 MiB after warm-up, and array buffers at 58 MiB.

Six checksum-distinct, 8-second excerpts from different positions of that same source recording were then processed sequentially in the same worker runtime. RSS started at 1065.5 MiB and measured 1153.1, 1189.9, 1189.0, 1207.3, 1231.6, and 1289.0 MiB. Warm-up retention was 123.5 MiB; final-half median RSS was 1260.3 MiB, 53.0 MiB above the first steady sample. Heap stayed at 26.0–26.2 MiB, external memory at 267.1–268.6 MiB, and array buffers at 58 MiB. Both continued-growth measurements were below the 128 MiB bound. The excerpts were not separate source songs.

**Why:** The longest repeated excerpt showed a clear allocator warm-up followed by a small RSS plateau. Changing real input excerpts retained more RSS after warm-up, but the measured growth remained bounded and JavaScript/external buffers stayed nearly flat.

**How to apply:** Treat this as Linux CPU evidence for one source recording only. It does not establish memory behavior across different songs or Windows/DirectML; repeat with multiple approved tracks and measure those providers separately.
