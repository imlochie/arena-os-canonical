---
name: Waveyard audio measurement windows
description: Keep waveform measurements tied to intended time windows and units.
---

Audio-analysis helpers should name interval units explicitly (seconds or milliseconds) and convert at the boundary. Compare source and rendered measurements over the same intended musical passage; confirm the measured window spans the passage before interpreting signal levels or adding thresholds.

**Why:** A route acceptance probe passed seconds to a helper treating arguments as milliseconds, so it inspected 2 ms instead of 2 seconds and falsely indicated that the arranged vocal was missing.

**How to apply:** For spectral energy, RMS, correlation, or beat metrics, encode units in parameter names, use typed duration wrappers when practical, and assert the intended source and rendered windows. Validate the measurement against a known signal before drawing conclusions about mixing or separation.
