---
name: Waveyard ordering coordination
description: Why queue and listening-session ordering share an owner-wide transaction lock.
---

Keep all queue/session ordering and membership changes under the same owner-wide transaction lock, acquired before reading the order. Compare any caller-provided expected order inside that lock.

**Why:** Queue edits can reorder or remove linked entries in several sessions. Separate queue/session row locks cannot protect empty lists and introduce inconsistent lock ordering. The owner-wide lock deliberately serializes these short edits rather than allowing unrelated resequencing paths to overwrite one another.

**How to apply:** New ordering writers must use the shared protocol for the entire read-modify-write operation, including compaction after deletion. Do not nest ordering transactions. A stale UI move should load current ordering and invite an explicit retry, not silently replay the old target against different slots. General up-next moves still intentionally differ from playlist-only slot-preserving moves.
