---
name: Waveyard clip donor provenance
description: Persist and resolve donor audio referenced only by Studio clips, independently from lane defaults.
---

A Studio clip can reference a stem asset that differs from its lane default, including audio linked from another library project. The clip's saved stem ID is authoritative for route state, browser preview, and render/export. Access checks, project source loading, version restoration, and library deletion protection must include clip-only references as well as lane defaults.

**Why:** A test that rewrote the lane row directly appeared to cover clip-only donor retention but skipped the real save route. A real clip edit exposed missing donor loading/validation, and the export worker's project-local-only assumption blocked linked audio.

**How to apply:** Exercise the real save/read/restore routes and inspect the stored `remix_clips` relation. Verify the actual asset route serves the donor file and a real render uses that donor's audio, not the lane default. Check access to every referenced donor project and keep clip-only donors protected from deletion.
