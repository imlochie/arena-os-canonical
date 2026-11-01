---
name: Arcade progress portability
description: Identity and confirmation rules when moving progress between imported copies.
---

An exact source match makes a progress backup eligible for an explicitly confirmed new import; it does not make two imports the same game identity.

**Why:** Identical filenames and source can represent separate playthroughs whose progress must remain isolated. Automatically aliasing them by content would undo that separation.

**How to apply:** Preserve the selected import's identity and source when restoring. Require explicit copy-migration confirmation for a different identity and exact source matching in that case. Existing identity across a source revision can be eligible with a clear compatibility warning; never replace source to make a progress backup match.

Treat restore previews as snapshots, not permission to overwrite subsequently changed progress.

**Why:** Gameplay can continue while the player selects a backup. Silently overwriting newer progress would hide the consequence of an old preview.

**How to apply:** Recheck committed progress before the restore write and invalidate stale previews. A same-tab check is not cross-tab transaction protection; other already-running players need separate stale-writer handling.

For a continuously running emulator, pause execution and new input during a valid restore preview, then resume on cancellation without accumulating a catch-up backlog.

**Why:** Machine state changes continuously even without an explicit save. A paused review is more usable than repeatedly invalidating its confirmation as the emulator advances.

**How to apply:** Keep inspection non-destructive, preserve the live run on storage failure, and retire the old runtime before its cleanup can autosave over a successful restore. Full machine snapshots contain program memory; describe them as local snapshots, not ROM-free progress files.
