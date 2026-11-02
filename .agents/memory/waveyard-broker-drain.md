---
name: Waveyard local broker drain lifecycle
description: Keep repeated drain calls accurate when new local jobs are submitted.
---

A local broker drain call must observe the queue at the time it is called. Do not retain a fulfilled drain promise as permanent broker state; later submissions need a fresh wait.

**Why:** During cancellation and restart validation, a stale fulfilled promise made newly queued work appear drained before its handler ran.

**How to apply:** Keep drain state tied to the live queue and verify a second submit-and-drain cycle after the first drain completes.
