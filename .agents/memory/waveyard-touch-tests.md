---
name: Waveyard touch gesture tests
description: Make mobile timeline gesture checks target visible controls and distinguish drag behavior from scrolling.
---

When testing timeline gestures with Playwright and CDP touch input, a clip's bounding box can extend well beyond the visible viewport. A touch dispatched into that offscreen portion may hit an ancestor instead of the clip, producing false failures for scrolling or selection.

**Why:** During phone-sized arrangement testing, a long clip was wider than the viewport and its center-based touch point was outside the visible area. Debugging the actual event target showed the gesture landing on the surrounding page rather than the clip or lane.

**How to apply:** Keep CDP touch starts inside the visible portion of controls and use `document.elementFromPoint` to confirm the target before interpreting native-scroll behavior. Test pointer-capture move/trim interactions with real touch input; verify lane movement thresholds, `touch-action`, and seek isolation separately.
