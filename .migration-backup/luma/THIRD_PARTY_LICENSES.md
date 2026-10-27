# Third-Party Licenses

LUMA is built entirely on permissively licensed open-source software. Every
runtime dependency is **MIT**, **BSD**, or **Apache-2.0**. There are **no
GPL/AGPL** dependencies. No proprietary assets, source code, branding, text, or
UI from any commercial application are used in this project.

This file is the authoritative license record; an in-app mirror is shown under
**Settings → Open-source licenses** (`src/data/licenses.ts`).

## Runtime dependencies

| Package | License | Purpose in LUMA |
| --- | --- | --- |
| `expo` (Expo SDK 57) | MIT | App framework, native modules, build tooling |
| `react` | MIT | UI library |
| `react-native` | MIT | Native UI runtime |
| `react-dom` / `react-native-web` | MIT | Web target support |
| `expo-router` | MIT | File-based navigation (bundles React Navigation, MIT) |
| `expo-camera` | MIT | Camera capture, flash, front/rear switch |
| `expo-image-picker` | MIT | Photo-library import |
| `expo-media-library` | MIT | Saving edited photos to the library |
| `expo-image` | MIT | Efficient image display |
| `expo-file-system` | MIT | Writing exported image files |
| `expo-sharing` | MIT | System share sheet |
| `expo-haptics` | MIT | Tactile feedback |
| `expo-blur` | MIT | (reserved) UI blur effects |
| `expo-linear-gradient` | MIT | (reserved) UI gradients |
| `expo-constants` | MIT | App metadata (version, etc.) |
| `expo-linking` | MIT | Deep-linking support for the router |
| `expo-splash-screen` | MIT | Launch screen |
| `expo-status-bar` | MIT | Status bar styling |
| `expo-system-ui` | MIT | System background color |
| `expo-font` / `expo-asset` | MIT | Font/asset loading |
| `@shopify/react-native-skia` | MIT | GPU image rendering (preview) + export |
| `react-native-reanimated` | MIT | Responsive animations & gesture-driven UI |
| `react-native-gesture-handler` | MIT | Direct-manipulation gestures |
| `react-native-worklets` | MIT | Worklet runtime powering Reanimated/Skia |
| `react-native-svg` | MIT | Vector icons |
| `react-native-safe-area-context` | MIT | Safe-area layout |
| `react-native-screens` | MIT | Native screen primitives |
| `@react-native-async-storage/async-storage` | MIT | Local settings/projects/presets storage |
| `zustand` | MIT | App state management |

## Dev dependencies

| Package | License | Purpose |
| --- | --- | --- |
| `typescript` | Apache-2.0 | Types & compilation |
| `jest` / `jest-expo` | MIT | Test runner + Expo preset |
| `react-test-renderer` | MIT | Test rendering |
| `eslint` / `eslint-config-expo` | MIT | Linting |
| `@types/*` | MIT | Type definitions |

## Policy

- Prefer MIT / BSD / Apache-2.0. Avoid GPL/AGPL unless truly unavoidable
  (currently: none).
- Any dependency that is useful for prototyping but unsuitable for production is
  isolated behind an adapter so it can be replaced. In V1, image processing is
  isolated behind the `ProcessingEngine` interface (`src/engine/ProcessingEngine.ts`);
  the current Skia backend can be swapped for a native Core Image/Metal backend
  without touching the UI.
- No proprietary assets or implementation details from WayShot, PicsArt, CapCut,
  or any other commercial app are copied. Preset recipes are original.
