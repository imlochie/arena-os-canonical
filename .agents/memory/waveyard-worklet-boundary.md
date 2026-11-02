---
name: Waveyard worklet test boundary
description: Keep Vite-specific audio worklet URL loading out of browser-independent stem transport code.
---

Audio DSP and live-stem layer code must not statically import Vite query modules such as `?worker&url`. The browser-facing transport adapter owns that import and passes the resolved worklet URL into the DSP layer. Non-browser callers that do not enable pitch preservation can omit the URL; attempts to enable it must fail clearly rather than silently degrade.

**Why:** Node's `tsx` runner and the esbuild-based audio acceptance harness cannot resolve Vite query imports. Putting that import in the core module broke unit and browser-audio transport tests even though Vite itself could build the app.

**How to apply:** Keep runtime asset resolution in the browser entry boundary. If an esbuild harness bundles the browser adapter, use a test-only URL stub; do not copy Vite-specific URL semantics into the audio core.
