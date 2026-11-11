---
name: Waveyard touch gesture tests
description: Make mobile timeline gesture checks target visible controls and distinguish drag behavior from scrolling.
---

When testing timeline gestures with Playwright and CDP touch input, a clip's bounding box can extend beyond the scrollport. A touch dispatched into that offscreen portion may hit an ancestor instead of the clip. Recomputing a selected point from a bounding-box fraction can also round it onto a nearby `touch-action:none` trim handle, falsely making native scrolling appear broken.

**Why:** Phone-sized arrangement testing exposed both failure modes: a center-based point landed outside the visible clip, and a later fraction-to-coordinate conversion shifted a valid body point onto the trim handle. In both cases the real CDP touch target differed from the intended timeline surface.

**How to apply:** Intersect the target with its scrollport and viewport, use `document.elementFromPoint` to find a small safe area away from controls, then dispatch at that exact validated coordinate rather than converting it back to a fraction. Capture the actual pointer target on failure. Test pointer-capture move/trim interactions separately; verify lane movement thresholds, `touch-action`, and seek isolation.

For persistence acceptance, distinguish gesture preview from server state: await the relevant move or remix-save response, retain successful API writes in the fixture's server-side state, and assert both edited values after reopening. Force a failed write separately, require visible failure feedback, and confirm reopening still shows the last successful values.

**Why:** A touch can update the timeline preview without reaching the persistence API, and reloading from an unchanged fixture cannot prove a save. A failure case must also avoid making an in-memory edit look durable.

**How to apply:** Use stateful API fixtures for browser round-trip checks; keep database-level endpoint coverage in the existing persistence integration suite rather than duplicating its broader audit.

Phone-layout acceptance should inspect the whole active route for horizontal overflow, not just the player card. Session handoff panels, native selects, and lower library forms can widen the page even when the stem controls themselves fit. When a phone test uses Restore, reset the server fixture to its pre-test state before later handoff assertions.

**Why:** A narrow viewport exposed offscreen controls that shifted the entire session, and a mobile restore action changed fixture state assumed by a later Studio handoff check.

**How to apply:** Check the document width and visible touch-target bounds at both a common phone width and a narrow width; include actionable overflow details in failures. Keep browser interaction side effects isolated from later tests by restoring fixture state explicitly.
