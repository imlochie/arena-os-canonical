---
name: Waveyard hook recurrence
description: Limits of short repeated-phrase evidence for verse/chorus recognition.
---

Treat short beat-aligned hook matches as supporting evidence, not whole-section labels. A hook can repeat in a chorus, bridge, breakdown, or outro; a familiar drum/bass loop can also make unrelated passages look similar. Require wider context and independent vocal/arrangement evidence before assigning a chorus role.

**Why:** Full-song comparisons of owner-annotated Queen and September audio found a plausible Queen chorus-to-chorus four-bar match, but similarly high scores also crossed chorus/breakdown/outro boundaries in September. Beat-shift tolerance and band-limited vocal onset flux did not resolve those false matches.

**How to apply:** Keep short motif candidates separate from verse/chorus ground truth. Evaluate the full recording against manually reviewed section boundaries, and do not relax a global similarity gate based only on one successful pair.
