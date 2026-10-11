/**
 * Thin haptics wrapper that respects the user's setting and degrades gracefully
 * where the native module is unavailable (web / tests).
 */

import { useSettingsStore } from '../state/settingsStore';

type Impact = 'light' | 'medium' | 'heavy' | 'selection' | 'success';

export function haptic(kind: Impact = 'light'): void {
  const enabled = useSettingsStore.getState().settings.haptics;
  if (!enabled) return;
  try {
    const H = require('expo-haptics');
    switch (kind) {
      case 'selection':
        H.selectionAsync();
        break;
      case 'success':
        H.notificationAsync(H.NotificationFeedbackType.Success);
        break;
      case 'light':
        H.impactAsync(H.ImpactFeedbackStyle.Light);
        break;
      case 'medium':
        H.impactAsync(H.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        H.impactAsync(H.ImpactFeedbackStyle.Heavy);
        break;
    }
  } catch {
    // No-op where haptics aren't available.
  }
}
