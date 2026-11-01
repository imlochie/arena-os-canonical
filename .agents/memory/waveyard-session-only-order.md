---
name: Session-only ordering
description: Why playlist-only reordering is distinct from explicit up-next cueing.
---

Playlist-only Up/Down controls reorder the session-only entries within their existing slots, leaving linked session entries and saved queue rows untouched.

**Why:** Playlist additions intentionally do not belong to the saved queue. Explicit up-next/Camelot cueing still needs unrestricted session positioning, so changing all session moves to slot-only behavior would break that separate intent.

**How to apply:** Keep playlist-only ordering explicitly scoped instead of redefining the general session-move contract. Identify duplicates by session-entry identity, not by library song identity.
