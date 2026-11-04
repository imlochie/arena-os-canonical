---
name: Waveyard Studio readiness refresh
description: Keep Studio selection readiness current as session source and stem assets change.
---

Background session refresh comparisons must include source asset identity and stem asset IDs, not only track membership, playback kind, or stem counts.

**Why:** A source can become unavailable or a stem set can be replaced without changing the number of tracks or stems. If the refresh treats those snapshots as equal, the Studio picker can retain a stale selectable choice.

**How to apply:** When changing session snapshot equality or picker readiness, test an asset becoming unavailable while the picker remains open, then verify it is unchecked/disabled and omitted from the handoff.
