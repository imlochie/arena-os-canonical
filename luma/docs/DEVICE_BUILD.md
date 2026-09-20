# Get LUMA onto your iPhone

This is the "LUMA escapes the repository" checklist. No Mac required — EAS builds in the cloud and gives you an install link / TestFlight build. This route requires paid Apple Developer membership; a free Apple ID cannot sign an EAS iOS device build. **You** run these
steps because they need your Apple ID and interactive `eas login`.

> LUMA lives in the `luma/` subdirectory of the repo. Run everything from there.

## 0. One-time prerequisites

- An **Apple Developer Program membership** (currently US$99/year, subject to Apple's pricing). EAS cloud builds for installing on a physical iPhone require Apple signing credentials. A free Apple ID is not sufficient for this EAS route.
- Node 18+ and npm.

```bash
cd luma
npm install
npm i -g eas-cli
eas login            # sign in to your Expo account (free)
```

## 1. Sanity-check locally (no device)

```bash
npm run typecheck    # clean
npm run lint         # clean
npm test             # 111 tests pass
npx expo export --platform ios   # confirms the JS bundle builds
```

## 2. Configure the EAS project

```bash
eas build:configure
```

This links the project to your Expo account and writes/refreshes the EAS project
id. `eas.json` already defines three profiles: `development`, `preview`,
`production`.

> **Bundle identifier:** `app.json` uses `com.luma.app`. If someone already owns
> that on your Apple account, change `expo.ios.bundleIdentifier` to something
> unique (e.g. `com.yourname.luma`) before building.

## 3. Build a development client (recommended for iteration)

A development build includes the native modules (Skia, Reanimated, Camera) and
lets you reload JS instantly from Metro — ideal while we keep building.

```bash
eas build --profile development --platform ios
```

EAS will:
1. ask to log in to Apple and register your **device UDID** (follow the prompts —
   it generates an ad-hoc provisioning profile automatically), then
2. build in the cloud and give you a QR code / install URL.

Open the URL on your iPhone, install, trust the developer profile
(Settings → General → VPN & Device Management), then run:

```bash
npx expo start --dev-client
```

Scan the Metro QR code with the LUMA dev build. You're now editing live on device.

## 4. Or build a standalone preview (nothing to run locally)

If you just want to *use* the app for a few days without Metro:

```bash
eas build --profile preview --platform ios
```

Install the resulting build the same way. This is the "use it for a few days"
build.

## 5. The loop to actually test

1. Open LUMA → the camera is the landing screen.
2. Swipe the camera strip (DigiCam · Clean · FilmBox · Mono · Nox); pick a look.
3. Tap the shutter.
4. In the editor: drag **Intensity**, tweak **Adjust** sliders.
5. **Press and hold** the photo to compare before/after.
6. Tap **Save** → grant Photos access → the edited copy lands in your library
   (your original is never touched).

## Troubleshooting

- **"Invalid bundle identifier"** → change `expo.ios.bundleIdentifier` in
  `app.json` to something unique and rebuild.
- **Camera is black in the dev build** → make sure you installed the *development
  build* (not Expo Go). Expo Go can't load Skia/Reanimated/Camera native code.
- **Build fails on a native module version** → run `npx expo install --check`
  and commit the suggested versions.
- **Nothing shows in Photos after Save** → confirm you granted "Add Photos"
  permission when prompted; re-enable in iOS Settings → LUMA if needed.

## Known caveat to expect on device

The **live viewfinder is tinted** to hint at the selected camera, but the feed
is not truly graded in real time (that needs a native frame processor — the top
roadmap item). The real look is applied, non-destructively, the instant you
capture and land in the editor.
