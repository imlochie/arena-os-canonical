# Remix Engine

The remix editor is a focused arrangement tool, not a full DAW. A remix session contains tracks and non-destructive clips. Clips reference a source/stem asset and store timeline start, source range, gain, pan and fades. Moving, trimming, splitting, duplicating and deleting clips changes arrangement data only.

The editor uses a single authoritative clock for all tracks. Autosave is debounced and exposes `Saving`, `Saved`, and offline/error state. Undo/redo records user actions such as clip and mixer changes. Snapshots provide lightweight named versions; restoring a version creates a new current state rather than mutating historical data.

Worker-side rendering rebuilds audio from the stored arrangement. Browser preview never stands in for a production export.
