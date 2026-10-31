---
name: Arcade emulator test evidence
description: Avoid mistaking emulator boot frames or import rejection for controller response or runtime sandbox evidence.
---

Wait for a fixture's known initialized screen before comparing controller press and release output. A non-black frame alone is not a stable baseline.

**Why:** JSNES can emit a provisional non-black frame before the ROM finishes initializing its palette. Comparing against that frame can falsely attribute startup changes to input and make a correct release appear broken.

**How to apply:** For original emulator fixtures, establish a known idle state, hold real input until the expected visible response appears, then verify release returns to idle.

Keep import-time refusal and runtime sandbox isolation as distinct checks.

**Why:** The imported-source filter examines raw source, including JavaScript expressions that resemble resource attributes. A fixture intended to exercise runtime isolation can be refused before its code executes.

**How to apply:** Confirm the imported fixture actually runs its attempted operations before asserting that the host URL, popup count, and external requests remain unchanged. Do not weaken the source filter to admit a test fixture.
