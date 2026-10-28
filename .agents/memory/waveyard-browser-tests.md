---
name: Waveyard browser audio tests
description: Keep browser-level transport and simulated asset-failure tests reliable.
---

Keep session fixture pages mounted while practical. When navigation is part of a test, intercept only that fixture's pagehide/visibility keepalive save before it can escape the mock routes. Keep ordinary mock routes active through teardown and assert visible UI plus actual playback and signal state, not just saved session data.

**Why:** A pagehide keepalive can bypass Playwright routing and send fake session data to the real API. Browser media caching can bypass a simulated outage, and playback time advances after a seek before later assertions run.

**How to apply:** Serve audio fixtures with `Cache-Control: no-store` for failure cases. Record recipient time when each donor buffer starts; normalize both offset and recipient clock modulo donor duration, then compare circular distance so end-of-loop and start-of-loop values match. For cancellation, hold the donor fetch, cancel through the UI, verify the original clock and gain continue with no donor buffer created, then release the held route before teardown.
