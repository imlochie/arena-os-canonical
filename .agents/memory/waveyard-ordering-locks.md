---
name: Waveyard ordering coordination
description: Why queue and listening-session ordering share an owner-wide transaction lock.
---

Keep all queue/session ordering and membership changes under the same owner-wide transaction lock, acquired before reading the order. Compare any caller-provided expected order inside that lock.

**Why:** Queue edits can reorder or remove linked entries in several sessions. Separate queue/session row locks cannot protect empty lists and introduce inconsistent lock ordering. The owner-wide lock deliberately serializes these short edits rather than allowing unrelated resequencing paths to overwrite one another.

**How to apply:** New ordering writers must use the shared protocol for the entire read-modify-write operation, including compaction after deletion. Do not nest ordering transactions. A stale UI move should load current ordering and invite an explicit retry, not silently replay the old target against different slots. General up-next moves still intentionally differ from playlist-only slot-preserving moves.

Read freshness must be coordinated per resource, not independently per refresh trigger, and a committed edit must invalidate older reads.

**Why:** Server-side ordering locks do not prevent an outstanding pre-edit GET from restoring old UI order. Library reloads, live notices, resume events, and background polling can overlap even when each individual path looks sequential.

**How to apply:** Any new queue or session refresh path must participate in the same freshness boundary as existing readers and committed edits. Check after asynchronous response parsing, not only after the HTTP response arrives.
