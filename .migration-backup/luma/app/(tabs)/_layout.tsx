/**
 * Bottom tab navigation: Camera · Edit · Create · Settings.
 *
 * Camera is the first (default) tab so it is always one tap away, matching the
 * product principle "camera-first". A custom tab bar keeps the visual language
 * minimal and photographic.
 */

import { Tabs } from 'expo-router';

import { TabBar } from '../../src/ui/components/TabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" options={{ title: 'Camera' }} />
      <Tabs.Screen name="edit" options={{ title: 'Edit' }} />
      <Tabs.Screen name="create" options={{ title: 'Create' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
