/**
 * Root layout.
 *
 * Sets up: gesture handler root, safe-area provider, dark status bar, and the
 * top-level stack. The tab navigator lives under (tabs); modal editor/create
 * screens are pushed on top so the Camera is always one tap away underneath.
 */

import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SystemUI from 'expo-system-ui';

import { useSettingsStore } from '../src/state/settingsStore';
import { palette } from '../src/theme/tokens';

export default function RootLayout() {
  const loadSettings = useSettingsStore((s) => s.load);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(palette.bg0).catch(() => {});
    loadSettings().catch(() => {});
  }, [loadSettings]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: palette.bg0 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.bg0 },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="editor"
            options={{ presentation: 'card', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="licenses" options={{ presentation: 'modal' }} />
          <Stack.Screen name="privacy" options={{ presentation: 'modal' }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
