---
name: Waveyard Apple Music backups
description: User's goal for backing up Apple Music metadata and accessible local audio without relying on TunePat.
---

The user does not want Waveyard to rely on TunePat or require paying for TunePat if Waveyard can provide the capability. Their goal is a usable Apple Music library backup with CSV metadata and actual audio files where accessible.

**Why:** The user said a metadata-only export would be useless as their complete backup and wants this as a product focus.

**How to apply:** Keep Apple Music metadata export separate from audio bytes unless local audio files are explicitly uploaded and matched. Preserve those original bytes and their embedded tags; do not claim that protected subscription streams can be downloaded or converted.

The user supplied a Waveyard engineering mission for a general-purpose, application-agnostic Windows audio recorder: WASAPI system and process-tree loopback, app/process discovery without a fixed whitelist, endpoint selection, PCM/RF64 capture, recovery, and integration with Waveyard's existing library and encoding paths. Avoid a custom virtual audio driver unless a demonstrated need justifies it. Apple Music is a compatibility test alongside other apps, not a hardcoded capture target.

**Why:** The user wants to investigate a first-party backup path rather than rely on TunePat, while preserving audio fidelity where the operating system and rights permit it. They explicitly require compatibility claims to be backed by actual test evidence and prohibit bypassing DRM or protected media paths.

**How to apply:** Prototype against generated test tones and user-owned or otherwise authorized audio. Reuse Waveyard's library intake and conversion rather than duplicating storage or encoders. Keep metadata separate from audio bytes; use documented APIs for metadata and media-session details. Do not bypass DRM or protected-output restrictions, and report the actual captured format and source rather than claiming bit-perfect source audio. Never claim app compatibility without a recorded run.

Treat signal detection as a diagnostic, not proof of fidelity, app compatibility, or protected-output behavior. Preserve low-signal recordings for inspection rather than deleting them or declaring them unusable.

**Why:** Legitimate recordings can be very quiet, while an idle loopback endpoint may deliver no packets at all. A level threshold cannot establish why audio is missing.

**How to apply:** Distinguish missing packets, received silence, and detected signal. Keep compatibility claims tied to a real recording/playback test, and label unavailable historical signal evidence as unverified.

Windows media-session metadata is a suggestion, not proof of the captured application's identity or a sample-aligned track boundary.

**Why:** GSMTC's current media session can belong to a different application, and its title-change timing is not aligned to the captured PCM stream.

**How to apply:** Keep tag retrieval optional and reviewable. Require confirmed capture-frame markers until source identity and boundary timing have independent evidence; never silently split recordings merely because a global media-session title changed.
