---
name: Playwright touch emulation
description: Keep mobile touch checks isolated from hover-dependent tests in the shared browser smoke suite.
---

Enable touch emulation only for the mobile interaction block, then disable and detach it before continuing the shared smoke suite. A context-wide `hasTouch` setting can change hover behavior in unrelated desktop checks.

**Why:** A global touch setting stopped a hover-revealed Arcade control from appearing in a later smoke test, even though the Studio touch checks themselves passed.

**How to apply:** When adding mobile taps to `scripts/arena-smoke.mjs`, use page-scoped CDP touch emulation around those checks and restore the desktop-default interaction mode afterward.
