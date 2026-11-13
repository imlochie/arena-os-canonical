---
name: Waveyard local phrase alignment
description: Confidence and native-tempo rules for live phrase matching.
---

Validate the section map's structure track-wide, but gate musical confidence on the active recipient section and each donor candidate. A weak unrelated section must not disable local phrase matching for the whole recording. Strong local beat-grid evidence may support rhythm/harmony comparison at native pace when global BPM confidence is weak; it must never authorize automatic tempo stretching.

**Why:** Real full-track section lists commonly contain many weak boundaries, while other passages have usable fingerprints. Whole-track confidence gates can discard every passage before comparing it. Local timing must still be sufficiently similar at native pace or fall back rather than imply sync.

**How to apply:** Keep source/stem provenance and feature confidence checks, reject weak active/candidate boundaries, preserve native speed under uncertain BPM, and require local duration/rhythm/harmony agreement before returning a match.
