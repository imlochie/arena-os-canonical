---
name: Waveyard worker memory peaks
description: Accurate peak-memory measurement for CPU inference inside Waveyard worker threads.
---

Use a parent-thread sampler for process RSS while ONNX inference runs in a worker. Native inference can block the worker event loop, causing its own interval timer to miss most of a long model pass. Sample worker-isolate heap, external memory, and array buffers separately, including at completed chunk callbacks, and label these as sampled peaks rather than allocation-trace maxima.

**Why:** A six-run pinned CPU measurement showed only a handful of worker timer samples during a long vocal-model pass, while the independent parent sampler captured substantially higher transient RSS peaks.

**How to apply:** When measuring worker-thread inference, record the active model pass and the sampling scope for each counter. Do not compare active-pass peaks with post-release RSS, and do not treat a passing leak-growth threshold as evidence that peak memory fits a low-memory device.
