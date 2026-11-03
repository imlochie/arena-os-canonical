---
name: Linux WebKit evidence
description: Distinguishes Linux Playwright WebKit runs from Apple Safari and native-device evidence.
---

Identify browser engine and host separately in WebKit reports. Playwright's Linux WebKit build can expose a Safari-shaped macOS user-agent string; that string is not evidence that the host is Safari or macOS.

On Replit Linux, Playwright's WPE headless build may fail to create an EGL display. Use the matching bundled GTK build under Xvfb with its helper-process and library paths configured instead of treating that host startup failure as an app regression.

**Why:** WPE can lack a usable EGL platform in the sandbox, while the GTK build can run under a virtual display; getting the browser executable and its bundled support libraries aligned may require a launcher. The browser user-agent labels WebKit as Macintosh Safari even when the process runs on Linux, and WebKit storage APIs may report that persistent storage was not granted despite ordinary profile data surviving a process restart.

**How to apply:** First verify the WebKit runtime itself can open a page. If WPE fails on EGL, try GTK under Xvfb. Record Playwright/WebKit version, host OS, persistence profile and `navigator.storage.persisted()` independently. Do not infer native Safari/iOS behavior or durable retention after browser eviction or user data clearing.
