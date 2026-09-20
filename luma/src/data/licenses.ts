/**
 * Third-party components used by LUMA and their licenses.
 *
 * This is the in-app data mirror of THIRD_PARTY_LICENSES.md. Every runtime
 * dependency is permissively licensed (MIT / BSD / Apache-2.0). No GPL/AGPL
 * dependencies are used, and no proprietary assets/code from any commercial app
 * are included.
 */

export interface ThirdPartyComponent {
  name: string;
  license: string;
  purpose: string;
}

export const THIRD_PARTY_COMPONENTS: ThirdPartyComponent[] = [
  { name: 'Expo SDK', license: 'MIT', purpose: 'App framework, native modules, build tooling' },
  { name: 'React Native', license: 'MIT', purpose: 'Native UI runtime' },
  { name: 'React', license: 'MIT', purpose: 'UI library' },
  { name: 'Expo Router', license: 'MIT', purpose: 'File-based navigation' },
  { name: 'expo-camera', license: 'MIT', purpose: 'Camera capture' },
  { name: 'expo-image-picker', license: 'MIT', purpose: 'Photo library import' },
  { name: 'expo-media-library', license: 'MIT', purpose: 'Saving edited photos' },
  { name: 'expo-image', license: 'MIT', purpose: 'Efficient image display' },
  { name: 'expo-file-system', license: 'MIT', purpose: 'Writing exported files' },
  { name: 'expo-sharing', license: 'MIT', purpose: 'System share sheet' },
  { name: 'expo-haptics', license: 'MIT', purpose: 'Tactile feedback' },
  { name: '@shopify/react-native-skia', license: 'MIT', purpose: 'GPU image rendering + export' },
  { name: 'react-native-reanimated', license: 'MIT', purpose: 'Responsive animations & gestures' },
  { name: 'react-native-gesture-handler', license: 'MIT', purpose: 'Direct-manipulation gestures' },
  { name: 'react-native-worklets', license: 'MIT', purpose: 'Worklet runtime for animations' },
  { name: 'react-native-svg', license: 'MIT', purpose: 'Vector icons' },
  { name: 'react-native-safe-area-context', license: 'MIT', purpose: 'Safe-area layout' },
  { name: 'react-native-screens', license: 'MIT', purpose: 'Native screen primitives' },
  { name: '@react-native-async-storage/async-storage', license: 'MIT', purpose: 'Local settings/projects storage' },
  { name: 'zustand', license: 'MIT', purpose: 'App state management' },
];
