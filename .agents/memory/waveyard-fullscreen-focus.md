---
name: Waveyard fullscreen focus
description: Focus recovery must be checked against visible layout, not just activeElement.
---

Fullscreen exit focus recovery must happen after the exit layout is committed. Keyboard-focused Visual controls must remain visible during playback.

**Why:** Focus can remain technically assigned while a fullscreen layout change places the control offscreen, a sticky header covers it, or an inactivity timer hides its container. Cleanup-time focus restoration can run before the new layout is ready.

**How to apply:** Test keyboard fullscreen entry and both Escape and button exits against viewport bounds, hit testing, focus indicators and overlay visibility. Include fullscreen-to-Studio unmounts and Tab wrapping; checking `activeElement` alone is insufficient.
