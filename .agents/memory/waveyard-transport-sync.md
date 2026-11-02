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
