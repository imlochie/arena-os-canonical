---
name: Playwright WebKit on Nix
description: Runtime library mismatch encountered when launching bundled Playwright WebKit in the Replit Nix environment.
---

Playwright's Linux WebKit bundle may require shared-library ABI versions that are unavailable from the configured Nix package index. A downloaded browser bundle is not evidence that the engine can launch. Do not create compatibility symlinks to a different ABI just to get a passing run.

The downloaded WebKit bundle's `MiniBrowser` helper resets `LD_LIBRARY_PATH` to
its bundled directories, which can hide required Nix host libraries. A working
launcher can invoke the bundled GTK `bin/MiniBrowser` directly under Xvfb while
setting `WEBKIT_EXEC_PATH`, `WEBKIT_INJECTED_BUNDLE_PATH`, and a compatible
library path; some hosts also need compatible GTK4 and libpng preloaded. Avoid
using the newest Nix libraries blindly: they may require a newer glibc than
the browser host provides. Verify an actual Playwright page load before running
the app journey.

**Why:** The browser process can fail before opening a page even when Firefox and Chromium are available; substituting a newer incompatible library would make audio and export results unreliable.

**How to apply:** Preflight the actual WebKit launch and required shared libraries. If WPE fails on EGL, try the matching GTK build under Xvfb and inspect its helper's environment setup before adding host libraries. Use supported matching dependencies or report the blocker plainly; do not label partial engine coverage as complete.
