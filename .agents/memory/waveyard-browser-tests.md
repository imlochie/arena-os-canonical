---
name: Waveyard browser audio tests
description: Keep browser-level transport and simulated asset-failure tests reliable.
---

Keep session fixture pages mounted while practical. When navigation is part of a test, intercept only that fixture's pagehide/visibility keepalive save before it can escape the mock routes. Keep ordinary mock routes active through teardown and assert visible UI plus actual playback and signal state, not just saved session data.

**Why:** A pagehide keepalive can bypass Playwright routing and send fake session data to the real API. Browser media caching can bypass a simulated outage, playback time advances after a seek, and session API state can change before React switches the displayed deck.

**How to apply:** Serve audio fixtures with `Cache-Control: no-store` for failure cases. Record recipient time when each donor buffer starts; normalize both offset and recipient clock modulo donor duration, then compare circular distance so end-of-loop and start-of-loop values match. For cancellation, hold the donor fetch, cancel through the UI, verify the original clock and gain continue with no donor buffer created, then release the held route before teardown. After queue changes, wait for the expected current-track identity alongside active audio and the Playing state; state-only checks can match the outgoing track.

A broad trace that attaches metadata to every native audio node and retains every gain node caused the cross-tab playback check to time out before the fade assertions; reverting that instrumentation restored the test.

**Why:** Audio graph instrumentation can change timing and object lifetime, and transition controls may appear before the audio fade reaches its midpoint.

**How to apply:** Prefer pure equal-power envelope tests and narrow existing gain probes. For browser fade assertions, poll a live gain value for the target envelope instead of sleeping a fixed delay after the transition control appears, then verify the intended incoming track. Add per-node tracing only when necessary, and first verify it does not alter playback timing.

For live source-to-stems handoffs, distinguish registered/staged audio elements from the channels currently required for playback. A failed staged channel must not pause the audible source, and a queued clock frame from the old channel set must not validate elements removed by the commit.

**Why:** A staged-source failure exposed that the shared transport clock treated every registered element as active; the handoff could then report success while every replacement element was paused.

**How to apply:** Keep active playback IDs explicit during staging. Test both a missing staged channel while the current mix advances and a successful commit where the new channels play without a stale-frame error.
