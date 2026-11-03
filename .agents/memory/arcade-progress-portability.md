---
name: Arcade progress portability
description: Identity and confirmation rules when moving progress between imported copies.
---

Keep portable HTML-source backups separate from gameplay-progress backups.

**Why:** The user wants active source, retained rollback copies, provenance and stable identity recoverable after browser data is cleared, without automatically replacing gameplay progress or uploading private bytes.

**How to apply:** Source restores require explicit collision/overwrite confirmation and must leave gameplay saves alone. Do not expand this source-backup feature into native/runtime packaging.

An exact source match makes a progress backup eligible for an explicitly confirmed new import; it does not make two imports the same game identity.

**Why:** Identical filenames and source can represent separate playthroughs whose progress must remain isolated. Automatically aliasing them by content would undo that separation.

**How to apply:** Preserve the selected import's identity and source when restoring. Require explicit copy-migration confirmation for a different identity and exact source matching in that case. Existing identity across a source revision can be eligible with a clear compatibility warning; never replace source to make a progress backup match.

Treat restore previews as snapshots, not permission to overwrite subsequently changed progress.

**Why:** Gameplay can continue while the player selects a backup. Silently overwriting newer progress would hide the consequence of an old preview.

**How to apply:** Recheck both committed bytes and the per-game revision under the write lock before restoring. The HTML save bridge advances that revision on writes, removes, clears, and restores; older tabs keep running but must explicitly reload or reconcile. Web Locks serialize cooperating tabs. Since localStorage has no compare-and-swap, browsers without Web Locks can only use best-effort checks; say so instead of claiming strict transaction guarantees.

Do not use an iframe `WindowProxy` alone to identify the active game document; the proxy can remain the same when that browsing context navigates to a new document.

**Why:** A delayed save message from the outgoing game's document was accepted after switching games even though the parent checked `event.source` against the active iframe window.

**How to apply:** Give each player document a distinct session ID, include it in save and clear messages, and accept messages only when both the game ID and current document session ID match. Test by holding a real outgoing-frame message and delivering it after switching games.

For a continuously running emulator, pause execution and new input during a valid restore preview, then resume on cancellation without accumulating a catch-up backlog.

**Why:** Machine state changes continuously even without an explicit save. A paused review is more usable than repeatedly invalidating its confirmation as the emulator advances.

**How to apply:** Keep inspection non-destructive, preserve the live run on storage failure, and retire the old runtime before its cleanup can autosave over a successful restore. Full machine snapshots contain program memory; describe them as local snapshots, not ROM-free progress files.

Keep live gameplay running during checkpoint deletion and failed-save recovery.

**Why:** Reloading as a storage-recovery mechanism discards the very in-memory progress that could not be saved. The requested behavior is to fix persistence without resetting the current run.

**How to apply:** Treat deleting a saved checkpoint and restarting a game as separate actions. A persistence warning must remain until the relevant live progress is durably committed or explicitly cleared, not merely until some unrelated key writes successfully. An oversized checkpoint remains unresolved even if its in-memory write was rolled back: recommitting the old, smaller state is not proof that the rejected checkpoint was saved.
