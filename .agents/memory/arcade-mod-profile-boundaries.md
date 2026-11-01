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

Framework loader runtime state needs an explicit writable, profile-private
location; copying loader DLLs into an immutable generation is insufficient.

**Why:** BepInEx 5 derives its root from the preloader assembly's location and
places configuration/cache/plugins beneath that root. A naive read-only
overlay may load files but cannot support normal configuration and recovery.

**How to apply:** Verify the pinned loader's own path behavior before choosing
a layout. Keep base content unchanged, preserve each profile's runtime state,
and do not infer functional plugin support from successful archive staging.

Treat all writable game-profile contents as game-controlled, including loader
core copies, configuration and logs. Preserve authoritative loader bytes and
state outside that writable capability.

**Why:** A native plugin can replace files, change attributes or plant links
in its own profile. Private per-profile storage prevents cross-profile access
but does not make its contents trusted for later main-process reads or repair.

**How to apply:** Bound reads, refuse links/special files, repair from protected
hash-checked sources, and recheck integrity before any future loader activation.
