---
name: Waveyard touch gesture tests
description: Make mobile timeline gesture checks target visible controls and distinguish drag behavior from scrolling.
---

When testing timeline gestures with Playwright and CDP touch input, a clip's bounding box can extend well beyond the visible viewport. A touch dispatched into that offscreen portion may hit an ancestor instead of the clip, producing false failures for scrolling or selection.

**Why:** During phone-sized arrangement testing, a long clip was wider than the viewport and its center-based touch point was outside the visible area. Debugging the actual event target showed the gesture landing on the surrounding page rather than the clip or lane.

**How to apply:** Keep CDP touch starts inside the visible portion of controls and use `document.elementFromPoint` to confirm the target before interpreting native-scroll behavior. Test pointer-capture move/trim interactions with real touch input; verify lane movement thresholds, `touch-action`, and seek isolation separately.

For persistence acceptance, distinguish gesture preview from server state: await the relevant move or remix-save response, retain successful API writes in the fixture's server-side state, and assert both edited values after reopening. Force a failed write separately, require visible failure feedback, and confirm reopening still shows the last successful values.

**Why:** A touch can update the timeline preview without reaching the persistence API, and reloading from an unchanged fixture cannot prove a save. A failure case must also avoid making an in-memory edit look durable.

**How to apply:** Use stateful API fixtures for browser round-trip checks; keep database-level endpoint coverage in the existing persistence integration suite rather than duplicating its broader audit.
