---
name: Linux WebKit evidence
description: Distinguishes Linux Playwright WebKit runs from Apple Safari and native-device evidence.
---

Identify browser engine and host separately in WebKit reports. Playwright's Linux WebKit build can expose a Safari-shaped macOS user-agent string; that string is not evidence that the host is Safari or macOS.

**Why:** The browser user-agent labels WebKit as Macintosh Safari even when the process runs on Linux, and WebKit storage APIs may report that persistent storage was not granted despite ordinary profile data surviving a process restart.

**How to apply:** Record Playwright/WebKit version, host OS, persistence profile and `navigator.storage.persisted()` independently. Do not infer native Safari/iOS behavior or durable retention after browser eviction or user data clearing.
