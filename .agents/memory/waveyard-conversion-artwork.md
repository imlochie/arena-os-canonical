---
name: Waveyard conversion artwork
description: Distinguishes embedded cover-art streams from ordinary video streams in FFmpeg inputs and fixtures.
---

FFmpeg identifies standard embedded album artwork through a stream's `attached_pic` disposition. An ordinary video stream in a Matroska file is not equivalent, even when it contains a still image.

**Why:** A conversion fixture built from a Matroska file with a still-image video stream did not exercise the embedded-art path; a tagged MP3 with an attached picture did.

**How to apply:** When testing source artwork detection or conversion, inspect FFprobe's `attached_pic` disposition and build fixtures with a real embedded cover stream.
