---
name: Waveyard Studio asynchronous edits
description: Preserve newer Studio changes when server responses arrive after an edit request.
---

Apply delayed mutation responses to the latest remix only when its session identity still matches the request. Record that current remix as the undo snapshot before applying the server change.

**Why:** Server responses may arrive after newer mixer or clip edits. A control can remain visually correct even when the canonical remix state has been replaced, so undo history and persisted state must be checked too.

**How to apply:** Keep the authoritative remix reference synchronized at edit boundaries, ignore responses for a different active session, and test with a held API response followed by another edit. Assert the resulting undo or save payload, not just the visible control value.
