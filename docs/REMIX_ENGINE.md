# Remix Sessions

Phase 2 implements a focused non-destructive arrangement domain, not a full DAW or an audio export engine.

## Persisted model

A `RemixSession` belongs to a project and has a name, master volume, optional loop range, current state version, tracks, clips, and named snapshots.

- A track is initialized from one existing project stem and stores name/order, volume, pan, mute, and solo.
- A clip references an existing stem and stores only `timelineStartMs`, `durationMs`, `sourceOffsetMs`, and gain.
- A version stores a serialized snapshot of that metadata; it contains no binary audio.

The server normalizes numeric values, bounds track/clip counts, verifies that the exact persisted tracks are being updated, and rejects every clip asset that does not belong to the session’s project. Project viewers can read sessions and snapshots; project editors create, save, restore, and snapshot them.

## Editor behavior

The Studio timeline permits start/length edits and duplicate/delete operations. Its changes are debounced to the authenticated remix API. Undo/redo remains bounded to 80 in-memory user actions, and named versions are persisted explicitly. Restoring a snapshot writes its state as the current arrangement; it does not mutate the historical snapshot.

The Studio transport is a real shared browser audition path for persisted stems: it has synchronized play/pause/stop/seek, a loop range, master gain, and per-stem gain/pan/mute/solo. It uses media elements and Web Audio nodes; it does not render, encode, upload, or claim to export audio. Browser-level timing correction is not sample-perfect synchronization.

## Deliberately absent

Phase 2 has no worker-side remix renderer, mixdown/export asset, BPM detection, beat grid, fades, arbitrary track creation, crossfades, collaboration/conflict resolution, or public publication. A future export must be a worker-owned job that reads the authoritative persisted arrangement and emits a newly validated private audio asset. It must never be substituted with browser playback.
