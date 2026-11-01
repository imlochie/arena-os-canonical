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
