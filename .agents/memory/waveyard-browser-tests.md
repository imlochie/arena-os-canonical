---
name: Waveyard browser audio tests
description: Keep browser-level transport and simulated asset-failure tests reliable.
---

Keep session fixture pages mounted while practical. When navigation is part of a test, intercept only that fixture's pagehide/visibility keepalive save before it can escape the mock routes. Keep ordinary mock routes active through teardown and assert visible UI plus actual playback and signal state, not just saved session data.

**Why:** A pagehide keepalive can bypass Playwright routing and send fake session data to the real API. Browser media caching can bypass a simulated outage, playback time advances after a seek, and session API state can change before React switches the displayed deck.

**How to apply:** Serve audio fixtures with `Cache-Control: no-store` for failure cases. Record recipient time when each donor buffer starts; normalize both offset and recipient clock modulo donor duration, then compare circular distance so end-of-loop and start-of-loop values match. For cancellation, hold the donor fetch, cancel through the UI, verify the original clock and gain continue with no donor buffer created, then release the held route before teardown. After queue changes, wait for the expected current-track identity alongside active audio and the Playing state; state-only checks can match the outgoing track.

For beat-snapped browser checks, schedule against a future synthetic boundary with enough lead for a loaded headless browser; use unit tests for exact pre-boundary and late-callback decisions. Run the live audio-graph test separately from the broad route smoke.

**Why:** A sub-second beat target was intermittently missed under browser-test scheduling load, correctly triggering the app's late-change cancellation rather than changing the mix late.

**How to apply:** Keep the browser assertion focused on audible gain and allow a realistic scheduling window. Do not treat a missed synthetic boundary under test contention as proof of a user-facing audio defect.

For app-background audio recovery tests, this workspace's Chromium build does not expose the CDP `Emulation.setPageVisibilityState` command. Override `document.visibilityState` in the test page and dispatch `visibilitychange`, while suspending real audio contexts and pausing actual media elements.

**Why:** The CDP visibility command failed as unsupported before the Studio recovery assertions could run.

**How to apply:** Use the deterministic document-state shim for lifecycle listeners and keep context/media interruption behavior native; describe this as simulated browser coverage, not physical phone acceptance.

A broad trace that attaches metadata to every native audio node and retains every gain node caused the cross-tab playback check to time out before the fade assertions; reverting that instrumentation restored the test.

**Why:** Audio graph instrumentation can change timing and object lifetime, and transition controls may appear before the audio fade reaches its midpoint.

**How to apply:** Prefer pure equal-power envelope tests and narrow existing gain probes. For browser fade assertions, poll a live gain value for the target envelope instead of sleeping a fixed delay after the transition control appears, then verify the intended incoming track. Add per-node tracing only when necessary, and first verify it does not alter playback timing.

For live source-to-stems handoffs, distinguish registered/staged audio elements from the channels currently required for playback. A failed staged channel must not pause the audible source, and a queued clock frame from the old channel set must not validate elements removed by the commit.

**Why:** A staged-source failure exposed that the shared transport clock treated every registered element as active; the handoff could then report success while every replacement element was paused.

**How to apply:** Keep active playback IDs explicit during staging. Test both a missing staged channel while the current mix advances and a successful commit where the new channels play without a stale-frame error.

For live-stem performance browser tests, report download, decode, tempo-match, and audible-start timings; use a controlled network delay instead of machine-specific latency gates.

**Why:** Headless Chromium varied by hundreds of milliseconds between download and decode stages on the same fixture, so a smaller injected delay could be obscured by normal scheduling noise.

**How to apply:** Compare the phase breakdowns and verify the measured download includes the injected delay. A mobile-sized Chromium viewport is useful layout and flow coverage, but it is not real-device or mobile-engine performance evidence.

For session-to-Studio reload checks, wait for a target timeline track before counting clips or mix controls; the project shell and mixer can mount before the remix request finishes. Use UUID-shaped project and remix fixture IDs so unmocked API routes do not stop at ID validation.

**Why:** The Studio view appeared while remix hydration was still pending, and synthetic non-UUID route IDs produced misleading API validation errors during page composition.

**How to apply:** In browser tests, synchronize on the expected track/clip elements, then assert linked audio IDs, mix values, and fades; keep project and remix fixture IDs UUID-shaped.

Long browser runs with short synthetic tracks must re-establish playback state before later cross-tab assertions. A transition may leave the primary paused, and the mirror must receive a fresh play event before testing that its pause control pauses the primary.

**Why:** The suite spends real time waiting on synthetic audio and transitions, so a previous state assumption can expire or become stale without a product failure.

**How to apply:** Before a mirror-tab control assertion, verify the primary's visible play state, ensure the mirror is still silent, then send and await explicit play and pause changes in both tabs.

Verify combined automatic fades against the live gain relationships, not the time when a transition control became visible. Outgoing source playback fades at deck master; outgoing separated stems and their donors fade at shared channel faders instead.

**Why:** UI observation can occur after the fade has advanced, and a stem deck's master can legitimately remain constant while every channel fades. Treating that master as the outgoing envelope produces false failures. Unequal source/stem mixes also need not have equal steady RMS.

**How to apply:** Normalize outgoing channel gains by their saved faders and compare their effective envelope with the live incoming deck gain. Measure per-deck PCM and compare quadrature energy against each deck's own steady baseline, with explicit window tolerances. Check incoming faders again after handoff and confirm a fresh donor actually starts through nonzero channel and master gains. Describe summed per-deck peak bounds and synthetic-fixture evidence accurately; neither proves arbitrary loud music or physical-device audio behavior.

Serve seek-sensitive WAV fixtures with real byte-range responses, including `Accept-Ranges`, `Content-Length`, and `Content-Range` on 206 responses.

**Why:** Chromium accepted decoded duration from a mocked WAV but kept returning a zero media position after nonzero seeks when the fixture did not support byte ranges. This falsely looked like a transport clock reset and an incorrect incoming beat offset.

**How to apply:** Implement requested byte slices in intercepted audio responses before diagnosing beat-offset failures. Seek through the visible transport control so its internal clock and the media element agree.

When a Studio gesture times out, inspect the actual element under the touch point and the browser's earlier errors before changing timeline behavior.

**Why:** An unrelated canvas-render exception opened Vite's full-page error overlay while the Studio controls remained visible underneath; gesture tests then misleadingly failed as if drag handling were broken.

**How to apply:** Use `document.elementFromPoint` at the intended control coordinates to distinguish an intercepted gesture from a control regression. Resolve the originating render error rather than bypassing the overlay.
