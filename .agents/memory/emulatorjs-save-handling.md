---
name: EmulatorJS save handling
description: Preserve EmulatorJS's built-in browser persistence when wiring player events.
---

Save/load event listeners in EmulatorJS can take ownership of persistence; a telemetry-only handler may prevent its built-in browser-storage path from running. Use the runtime's browser-storage settings unless Arcade implements complete custom save and restore behavior.

**Why:** A no-op save callback looked harmless but suppressed the runtime's default save handling.

**How to apply:** Do not register custom save/load callbacks just to update the surrounding UI. Verify that a state actually persists and can be restored from browser storage after reload.
