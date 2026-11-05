---
name: Playwright touch emulation
description: Keep mobile touch checks isolated from hover-dependent tests in the shared browser smoke suite.
---

Enable touch emulation only for the mobile interaction block, then disable and detach it before continuing the shared smoke suite. A context-wide `hasTouch` setting can change hover behavior in unrelated desktop checks. For mobile controls, exercise the actual touch gesture and assert the resulting behavior; do not treat hover-only prefetch as a mobile action, or require a network event when the selected donor may already be cached.

Chromium's CDP touch emulation can verify browser-native horizontal panning: start on a visible clip and assert the timeline's `scrollLeft` changes while the playhead and clip position stay fixed. Synthetic pointer events do not exercise native scrolling. Chromium emulation is not proof of iOS Safari or physical Android Chrome behavior.

**Why:** A global touch setting stopped a hover-revealed Arcade control from appearing in a later smoke test, even though the Studio touch checks themselves passed. A live-swap test also showed that donor selection can succeed on touch without the hover-only prefetch request the desktop test expects. Synthetic pointer dispatch cannot validate the browser's native pan arbitration, and desktop Chromium cannot establish behavior on real phone browsers.

**How to apply:** Use page-scoped touch emulation for mobile checks, start gestures on visible targets, assert the end-user outcome rather than hover-prefetch timing, and restore desktop-default interaction mode afterward. For Safari or real-device claims, run the same checks on the named browser/device and report them separately from emulation.
