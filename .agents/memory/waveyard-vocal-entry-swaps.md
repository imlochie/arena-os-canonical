---
name: Waveyard vocal-entry swaps
description: Real-time acceptance for phrase-snapped donor vocals and independently retained tempo-master stems.
---

When a donor is prepared while the recipient session is playing, verify its
actual transformed buffer start against the selected source cue and the
recipient clock at start. Preparation can span several seconds; a source offset
that was correct before preparation may be stale by the time it becomes audible.

In a multi-role swap, restore validation must identify the selected vocal
source, prove that source retires, and separately prove that an unrelated
preloaded tempo-master stem remains active. A count of every newly created
audio source is not a valid proxy for which role is being restored.

**Why:** Real full-length stems showed that live preparation can move the
recipient playhead substantially, while preloaded drum audio may be created
after the test's initial buffer snapshot and remain intentionally active after
the vocal donor is restored.

**How to apply:** For real vocal-entry acceptance, warm the donor before apply,
measure the actual source offset, tempo ratio, recipient time, and apply-to-audio
latency, then test role-specific restore. Describe pitch-continuity intervals
as acoustic voiced-run candidates, not as lyric or verse/chorus ground truth.
