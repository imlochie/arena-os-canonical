# Arcade progress backup WebKit fixture

The reproducible fixture uses the original HTML source as a local game, exports its saved progress, imports the same source into fresh browser storage, and restores the exported file only after explicit copy confirmation. It checks reload persistence, source and other-save isolation, malformed files, cancellation, storage refusal, and mobile keyboard/touch access.

Run the isolated flow against Playwright WebKit with:

```sh
node scripts/arcade-progress-webkit.mjs
```

The environment must have the Playwright WebKit browser and its system libraries. `WEBKIT_HEADLESS=0` selects the GTK build for a display-backed run; `WEBKIT_PATH` can point to a custom Playwright-compatible launcher, and `WEBKIT_LIBRARY_PATH` can provide host library directories when needed. The report and mobile screenshot are written under the ignored `generated-artifacts/arcade-progress-webkit/` directory.

This is automated WebKit evidence, not Apple Safari evidence. Download and file selection use Playwright APIs; picker cancellation is a dispatched event; storage refusal is injected. It does not exercise the iOS Files app or a physical iPhone/iPad.
