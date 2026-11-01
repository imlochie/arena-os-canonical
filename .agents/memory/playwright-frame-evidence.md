---
name: Playwright frame evidence
description: Script-content assertions need DOM evaluation, not Playwright text filters; parent state is not iframe readiness.
---
Playwright text filtering excludes script/style elements. It cannot wait for a game's script code using a text filter, even when that code is present.

**Why:** this tool behavior can turn a correct source revision into a false timeout. Conversely, a parent success notice can appear before the iframe commits the new document.

**How to apply:** inspect script text through DOM evaluation with a bounded readiness poll when checking emitted game code, then verify real input and visible gameplay outcomes. Neither a source attribute nor a parent status alone proves the active document changed.
