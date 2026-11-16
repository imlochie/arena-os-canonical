---
name: Waveyard hook recurrence
description: Limits of short repeated-phrase evidence for verse/chorus recognition.
---

Treat short beat-aligned hook matches as supporting evidence, not whole-section labels. A hook can repeat in a chorus, bridge, breakdown, or outro; a familiar drum/bass loop can also make unrelated passages look similar. Near-continuous vocal activity plus sparse monophonic pitch is not enough to distinguish semantic roles. Timestamped lyric recurrence is the next independent evidence layer for identifying repeated chorus lines.

**Why:** Full-song comparisons of the checksum-pinned Queen and September stems showed the current detector abstaining on Queen's provisional verse/chorus regions and misplacing part of September's second chorus. Vocal activity is nearly continuous, pitch tracking is sparse, and a repetitive backing can dominate similarity. Threshold changes alone do not supply the missing lexical distinction.

**How to apply:** Keep motif candidates separate from semantic section labels. Use timestamped transcript segments only with explicit consent to send audio to the selected provider; otherwise retain generic structure and abstain. Evaluate the full recording against manually reviewed boundaries, and do not relax global thresholds based on one successful pair.
