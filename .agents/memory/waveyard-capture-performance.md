---
name: Capture performance evidence
description: Why signal monitoring remains in the capture write path and how to assess its cost without measuring the harness instead.
---

Keep signal observation in the serialized recording path unless representative
pipe-chunk measurements demonstrate a responsiveness problem. Do not move it to
a separate worker just because stem separation requires one.

**Why:** Streaming measurements found bounded observer work and responsive
controls with ordinary pipe chunks. Copy elimination and cached normalization
reduced CPU without adding another PCM queue, worker lifecycle or failure path.
This decision is specific to signal observation, not audio separation.

**How to apply:** Measure actual chunk sizes, retain incomplete frames without
retaining incoming chunks, and preserve exact diagnostic counts and PCM bytes.
Use paired disk-only and disk-plus-observer runs before attributing recording
CPU to observation.

Do not treat a profiling harness's heap growth as retained PCM history.

**Why:** An unrestricted HTTP probe loop dominated early CPU measurements;
even rate-limited probes grew shared HTTP/runtime warmup state during the
short accelerated soak. Observer-only retention controls showed constant
ArrayBuffer usage instead.

**How to apply:** Rate-limit control probes and run separate source-only versus
observer retention checks without repeated HTTP allocations. Inspect post-GC
ArrayBuffer trends and ownership bounds alongside heap/RSS, and label
accelerated Linux data as synthetic evidence rather than Windows/native
acceptance. The reproducible methodology and observed results belong in
desktop/CAPTURE_PERFORMANCE.md, not this memory.
