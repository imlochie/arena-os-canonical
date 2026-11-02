---
name: Playwright touch emulation
description: Keep mobile touch checks isolated from hover-dependent tests in the shared browser smoke suite.
---

Enable touch emulation only for the mobile interaction block, then disable and detach it before continuing the shared smoke suite. A context-wide `hasTouch` setting can change hover behavior in unrelated desktop checks.

Chromium's CDP touch emulation can verify browser-native horizontal panning: start on a visible clip and assert the timeline's `scrollLeft` changes while the playhead and clip position stay fixed. Synthetic pointer events do not exercise native scrolling. Chromium emulation is not proof of iOS Safari or physical Android Chrome behavior.

**Why:** A global touch setting stopped a hover-revealed Arcade control from appearing in a later smoke test, even though the Studio touch checks themselves passed. Synthetic pointer dispatch also cannot validate the browser's native pan arbitration, and desktop Chromium cannot establish behavior on real phone browsers.

**How to apply:** When adding mobile checks to `scripts/arena-smoke.mjs`, use page-scoped CDP touch emulation around those checks, start swipes on visible targets, assert native scroll plus unchanged seek/clip state, and restore desktop-default interaction mode afterward. For Safari or real-device claims, run the same checks on the named browser/device and report them separately from emulation.
