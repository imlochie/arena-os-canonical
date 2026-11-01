---
name: Mod profile boundaries
description: Why rollback and portable mod profiles must not overwrite base games or rewind saves.
---
Mod profile rollback restores reviewed content/settings, not old saves. Sharing the base game's saves must be explicit; native profiles require distinct OS sandbox identities as well as separate writable directories.

**Why:** The user wants real mod capability without losing prior work. Rewinding saves with content rollback, or isolating paths while sharing an OS sandbox identity, can silently mix or destroy progress.

**How to apply:** Preserve immutable base content and private save ownership when adding adapters. Export only authorized mod payloads with pinned base requirements, never base games or implicit save copies. Distinguish validated patch composition from real game/Windows execution evidence.

Save-sharing scope must match on portable restore; reject mismatches before importing packages rather than silently using the destination's setting. Disabled installed packages must remain discoverable independently of the enabled execution order.

**Why:** Restore into a shared destination can otherwise write to base-game saves despite an isolated backup. Using enabled load order as the inventory makes disabled mods disappear, preventing reversible editing.

**How to apply:** Treat save scope, inventory and resolved execution order as separate concerns in new loaders and migration tools.
