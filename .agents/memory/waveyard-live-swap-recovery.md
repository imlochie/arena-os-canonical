---
name: Waveyard live-swap recovery
description: Preserve audible playback and a usable retry when a donor layer fails.
---

When a live donor fails, keep the previous layer audible and restore the last valid saved donor choice. Retain the failed donor candidate separately until the user retries it, chooses another source, or a replacement succeeds. A healthy original stem playing again must not clear the retry option.

**Why:** A donor failure and the previous layer's playback health are separate states. Rolling back the saved choice changes the session data, while a successful play event from the retained layer can clear a shared transient media error.

**How to apply:** Test failed swaps both with and without a previous donor. Confirm the old mix and clock continue, the saved source returns to the previous valid choice, retry remains visible, and retry resubmits the same donor without affecting other stems.

Shared encoded-audio caches must invalidate bytes rejected by the decoder, not just failed HTTP responses. Scope invalidation to the rejected response so a late failure cannot evict a newer download. Keep audible media leases alive, but refresh standby leases when fresh bytes arrive.

**Why:** An HTTP 200 can contain corrupt audio; retaining it makes an explicit retry fail repeatedly without reaching the server. Revoking an existing deck lease during invalidation can interrupt unrelated playback.

**How to apply:** Exercise a corrupt response followed by valid bytes at the same URL. Verify retry repairs the donor and standby deck, then actually transition to the repaired next track. Releasing an old lease must not evict the replacement.
