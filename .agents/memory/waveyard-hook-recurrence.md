---
name: Waveyard hook recurrence
description: Limits of short repeated-phrase evidence for verse/chorus recognition.
---

Treat short beat-aligned hook matches as supporting evidence, not whole-section labels. A hook can repeat in a chorus, bridge, breakdown, or outro; a familiar drum/bass loop can also make unrelated passages look similar. Near-continuous vocal activity plus sparse monophonic pitch is not enough to distinguish semantic roles. Local Whisper tiny/base drafts failed to recover the known chorus phrases in the pinned September and Queen vocal stems; do not treat unreviewed ASR text as reliable lyric-recurrence evidence.

**Why:** Full-song comparisons of the checksum-pinned Queen and September stems showed the current detector abstaining on Queen's provisional verse/chorus regions and misplacing part of September's second chorus. Q8 Whisper tiny and base also missed each track's known chorus phrase. Vocal activity is nearly continuous, pitch tracking is sparse, and a repetitive backing or unverified transcript can dominate similarity. Threshold changes alone do not supply the missing lexical distinction.

**How to apply:** Keep motif candidates separate from semantic section labels. Local transcript drafts must stay on-device, bind to source and stem checksums, and remain outside the planner until lyric accuracy is validated or the user corrects them. If external transcription is offered, require explicit consent because the audio leaves the device. Evaluate the full recording against manually reviewed boundaries, and do not relax global thresholds based on one successful pair.
