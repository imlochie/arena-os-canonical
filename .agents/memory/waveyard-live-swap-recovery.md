---
name: Waveyard live-swap recovery
description: Preserve audible playback and a usable retry when a donor layer fails.
---

When a live donor fails, keep the previous layer audible and restore the last valid saved donor choice. Retain the failed donor candidate separately until the user retries it, chooses another source, or a replacement succeeds. A healthy original stem playing again must not clear the retry option.

**Why:** A donor failure and the previous layer's playback health are separate states. Rolling back the saved choice changes the session data, while a successful play event from the retained layer can clear a shared transient media error.

**How to apply:** Test failed swaps both with and without a previous donor. Confirm the old mix and clock continue, the saved source returns to the previous valid choice, retry remains visible, and retry resubmits the same donor without affecting other stems.
