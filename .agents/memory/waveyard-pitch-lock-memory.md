---
name: Waveyard pitch-lock memory
description: Aggregate decoded PCM and transient migration allocations when enabling pitch lock for live-swapped stems.
---

Pitch-lock memory is a per-session aggregate across decks sharing the session AudioContext, not a per-stem or per-deck allowance. Estimate retained PCM for every live and retiring donor, then reserve for the active migration copies and one decoded donor whose backing store may await browser reclamation. The current session cap is 512 MiB.

**Why:** Four three-minute 48 kHz stereo donors retain about 264 MiB and showed an `ArrayBuffer` high-water mark of 436 MiB in the measurement run. A single-donor limit multiplied by four misses migration overlap and delayed garbage collection.

**How to apply:** Estimate from each decoded buffer's actual frame count and channel count across both decks on the shared context; reject before migration or replacement if the aggregate exceeds the cap, and leave the existing mix playing. Browser instrumentation must inspect a short view of transferred PCM rather than copy a full channel for analysis.
