---
name: Arcade capability scope
description: The user's product expectation for prompt-created, imported, modifiable games and saved local progress.
---

The user expects Arcade to create playable games from prompts, import authorized games and run them, support gameplay-changing prompts for editable source, and preserve progress locally. Saved starter games are examples, not the product ceiling. Clearly identify engine and format limits; one runtime cannot honestly claim universal game support.

**Why:** The user repeated this expectation after earlier Arcade passes leaned too heavily on presets or browser-only imports.

**How to apply:** Prioritize real game creation and import/runtime capability, then source-based gameplay edits and local saves. State unsupported formats plainly rather than implying every game can be imported or modified.

Repository acquisition and reproducible game builds are separate capabilities. A source preview or offline import must not grant repository install/build scripts access to the API process.

**Why:** This is a safety boundary, not a change to the user's broader create/import/mod vision. A constrained first importer must not become an excuse to abandon projects that need a real build pipeline.

**How to apply:** Expand build-dependent game acquisition through a separately governed build/runtime path. Keep refusals specific, preserve pinned-source attribution through edits, and distinguish successful downloads from verified playable games.

Do not silently reclassify existing classic CHIP-8 games when expanding dialect support. Ambiguous program files need explicit dialect selection; universal-manifest migrations must preserve the original interpreter semantics.

**Why:** Classic CHIP-8 and Super-CHIP disagree on shifts, register transfers, jumps and drawing. A technically valid reinterpretation can change gameplay or invalidate old progress, contrary to the user's requirement not to regress working games.

**How to apply:** Preserve legacy defaults and save identity when adding adapters or migrating records. Keep compatibility-profile limits explicit rather than advertising every historical implementation as equivalent.

Source restoration is not permission to rewind gameplay progress.

**Why:** The requested recovery behavior is to restore game code while retaining the same game's identity and browser progress. An older code version and an older save are separate user choices.

**How to apply:** Keep those choices separate when extending revision history, profiles and portable backups; do not silently replace or erase progress to make restored source appear compatible.

Bound retained source by total bytes as well as copy count, including bundled media.

**Why:** Offline HTML games can embed large images and audio even when the editable code sent to a model is small. A short history can still multiply storage and memory costs, which conflicts with the user's resource concerns.

**How to apply:** Budget full stored source, not the media-stripped model prompt, and make retention limits visible before players rely on history as a permanent backup.

Do not reuse per-document model media markers as comparison identities.

**Why:** Position-based markers serve asset preservation during model edits, but independently masking two versions can give different images or audio the same marker and hide a real change.

**How to apply:** Compare embedded data with a shared exact-value identity across both versions, keep raw-source equality separate from display normalization, and leave the model's asset-preservation contract unchanged.

A stable iframe key does not prevent navigation when its `srcDoc` changes.

**Why:** The save bootstrap embeds initial progress. Rebuilding it after a first-save or last-key-clear indicator update restarted live gameplay even though game identity and source were unchanged.

**How to apply:** Treat initial progress as a bootstrap snapshot. Ordinary persistence/indicator updates must not rewrite the live document; changing game/source or explicitly reloading may initialize a fresh snapshot.
