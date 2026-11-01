---
name: Playwright frame evidence
description: Iframe readiness, script-content assertions and short-clip playback evidence in browser tests.
---
Playwright text filtering excludes script/style elements. It cannot wait for a game's script code using a text filter, even when that code is present.

**Why:** this tool behavior can turn a correct source revision into a false timeout. Conversely, a parent success notice can appear before the iframe commits the new document.

**How to apply:** inspect script text through DOM evaluation with a bounded readiness poll when checking emitted game code, then verify real input and visible gameplay outcomes. Neither a source attribute nor a parent status alone proves the active document changed.

Arm short-audio playback evidence before the trusted button click, rather than attaching the first listener after the click finishes.

**Why:** A short fixture can start and finish before browser automation returns from the click; checking only current playback or waiting for a future event then falsely reports silence.

**How to apply:** Reset per-attempt evidence and install the playback listener first, perform the real UI click, and assert the recorded event. Verify the assertion still rejects a silent click so earlier playback cannot mask a broken button.
