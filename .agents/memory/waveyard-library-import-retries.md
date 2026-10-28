---
name: Waveyard library import retries
description: A timed-out library import can keep running while a retry creates duplicate tracks and separation jobs.
---

A client timeout does not guarantee that the server stopped importing the audio. A concurrent retry can pass the checksum lookup before the first request commits, producing duplicate source rows, library entries, and jobs.

**Why:** Full-length CPU separation can leave the API process slow to respond after the upload body has already arrived.

**How to apply:** Avoid blind retries of library uploads. Make checksum-based intake atomic and test concurrent duplicate POSTs so exactly one source, track, and separation job are created.
