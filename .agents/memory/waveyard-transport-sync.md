---
name: Waveyard cross-tab transport
description: Rules for mirroring live session state between browser tabs without duplicate playback or stale playhead changes.
---

Tabs showing the same Waveyard session share track, play/pause, seek position, and session-order changes. A receiving tab mirrors state but does not autoplay its own audio engine. A seek from a mirror can reposition the active tab while preserving playback when the same track remains active.

Control events are authoritative; progress heartbeats are passive and accepted only from the current control sender at the same logical clock. Older or concurrent passive updates must not undo a newer user action.

**Why:** Each browser tab mounts its own audio graph, so independent controls can create duplicate playback or let a delayed playhead overwrite a newer pause, seek, or track change.

**How to apply:** Keep transport synchronization in the shared queue-sync channel. When changing event shapes, retain ordering and mirror-without-autoplay behavior, and test two real browser pages against one session.

An unreported deck starting playback is still a user control and must publish the first play event. An unreported paused state is not a new command and should stay silent.

**Why:** Suppressing a first play when the deck had no prior reported state left the mirror tab's controls showing paused even while the active tab played.

**How to apply:** When gating play-state broadcasts, publish `unknown → playing`, but do not broadcast `unknown → paused`. Test after a fresh mount and after a track change.

Explicit speed controls from a mirror tab must publish even while the tab is applying a passive remote playhead update; only synthetic transport side effects should be suppressed during that brief window.

**Why:** A speed slider could change locally and then snap back on the next owner heartbeat because its control event was blocked by the remote-apply guard.

**How to apply:** Keep explicit user controls authoritative, retain sender/clock ordering for heartbeats, and test a mirror speed change during active playback plus a deliberately stale heartbeat.

Stem fader and mute edits from a tab must send only the changed stem keys. The service merges those keys with the latest saved mix under a row lock; preserve full-mix replacement only for deliberate whole-mix updates. Same-tab writes for one track remain serialized, and a fader change must not send an unchanged transition snapshot.

**Why:** Two tabs can hold stale full-mix snapshots. The last whole-object write could silently erase another tab's gain or mute, including its remembered unmute level.

**How to apply:** Test real UI controls in two tabs with the later tab's response applied first, then reload and verify saved gains reach the audio graph. Also verify independent concurrent partial writes against the real database.
