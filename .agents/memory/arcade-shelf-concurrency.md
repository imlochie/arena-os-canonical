---
name: Arcade shelf concurrency
description: Why local game-shelf writes require transactional conflict checks and identity-preserving, targeted refreshes.
---

Cross-tab notifications are advisory, not permission to overwrite a saved game. Check the affected record's committed version inside the same transaction that writes or deletes it.

**Why:** Background tabs can miss or delay notifications, and independently loaded snapshots can both appear valid. Refreshing the UI alone cannot prevent a stale edit from overwriting newer source or resurrecting a deleted game.

**How to apply:** Keep conflict checks atomic with mutations. A failed save must not advance the committed baseline. Retries must preserve the game's identity and save-data keys rather than create a replacement game. Do not discard unsaved drafts when a peer announces a change.

Refresh changed records and preserve unchanged game-object identities rather than treating every notification as a full shelf replacement.

**Why:** IndexedDB reads structured-clone large ROM buffers even in readonly transactions. Replacing an unchanged ROM/player identity can also restart a running emulator, independently of whether the stored bytes changed.

**How to apply:** Ignore self-notifications, read announced IDs for ordinary peer updates, and reconcile missed background events when needed. Serialize partial refreshes so one notification cannot cancel another changed ID. Preserve the existing object for an unchanged record.

Concurrency metadata alone does not justify a destructive browser-database migration.

**Why:** Existing shelf clients and regression tools share the established database contract; a version bump requires coordinated legacy-client handling.

**How to apply:** Prefer compatible per-record revisions for this purpose. If future manifest work genuinely needs a schema change, explicitly address old clients and retained game/save data rather than clearing the shelf.

Distinguish read-only notification refreshes from write-transaction conflict checks when measuring browser storage operations.

**Why:** A live peer notification can legitimately read the same ID while a stale save checks it. Counting all tab-wide reads as one save's work falsely reports duplicate operations and makes the concurrency regression timing-dependent.

**How to apply:** Tag storage probes by transaction mode. Require exactly one guarded read in the write transaction, retain assertions that stale conflicts make no mutations, and deliberately overlap a read-only refresh to keep this race covered.
