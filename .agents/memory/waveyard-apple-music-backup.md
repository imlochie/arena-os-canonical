---
name: Waveyard Apple Music backups
description: User's goal for backing up Apple Music metadata and accessible local audio without relying on TunePat.
---

The user does not want Waveyard to rely on TunePat or require paying for TunePat if Waveyard can provide the capability. Their goal is a usable Apple Music library backup with CSV metadata and actual audio files where accessible.

**Why:** The user said a metadata-only export would be useless as their complete backup and wants this as a product focus.

**How to apply:** Keep Apple Music metadata export separate from audio bytes unless local audio files are explicitly uploaded and matched. Preserve those original bytes and their embedded tags; do not claim that protected subscription streams can be downloaded or converted.

The user also wants to explore a personal Windows capture application for audio rendered during normal, authorized playback, using OS loopback or a virtual audio device, with PCM capture and MP3/AAC/WAV/ALAC/FLAC exports. This is an exploration, not evidence that Apple Music streams can or may be exported. WASAPI loopback captures the rendered endpoint mix rather than the source file, and protected output may be withheld by the operating system.

**Why:** The user wants to investigate a first-party backup path rather than rely on TunePat, while preserving audio fidelity where the operating system and rights permit it.

**How to apply:** Prototype against generated test tones and user-owned or otherwise authorized audio. Keep Apple Music metadata access separate from audio bytes; use documented APIs for metadata and media-session details. Do not bypass DRM or protected-output restrictions, and report the actual captured format and source rather than claiming bit-perfect source audio.
