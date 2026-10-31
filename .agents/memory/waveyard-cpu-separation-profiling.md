---
name: Waveyard CPU separation profiling
description: Performance findings and profiling priorities for local four-stem CPU separation.
---

On the measured Linux CPU path, TypeScript STFT/ISTFT work dominated the four-model separation runtime; ONNX inference was a minority of measured transform time. Repeated FFT twiddle-factor calculation was a meaningful avoidable cost.

**Why:** Stage-level timings on the production local-worker path showed that optimizing ONNX options alone would miss the largest CPU cost. The cached-twiddle optimization retained the existing transform test guarantees and improved the same 20-second benchmark.

**How to apply:** When local separation is slow, use the opt-in real-audio report’s stage timings first. Treat Linux results as Linux-only evidence, and do not infer separation quality from RMS or peak measurements.
