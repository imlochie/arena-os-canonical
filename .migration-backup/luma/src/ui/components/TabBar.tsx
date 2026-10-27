/**
 * Custom bottom tab bar — minimal, dark, thumb-friendly.
 *
 * Uses simple vector glyphs (react-native-svg) instead of an icon font to keep
 * dependencies light and the visual language restrained.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';

import { haptic } from '../haptics';
import { palette, spacing, typography } from '../../theme/tokens';
import { TabIcon, TabIconName } from './TabIcon';

const ICONS: Record<string, TabIconName> = {
  index: 'camera',
  edit: 'sliders',
  create: 'layers',
  settings: 'gear',
};

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View style={styles.bar}>
        {state.routes.map((route, index) => {
          const descriptor = descriptors[route.key];
          const options = descriptor?.options ?? {};
          const label = (options.title ?? route.name) as string;
          const focused = state.index === index;
          const icon = ICONS[route.name] ?? 'camera';

          const onPress = () => {
            haptic('selection');
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={styles.item}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
            >
              <TabIcon
                name={icon}
                color={focused ? palette.text : palette.textFaint}
                size={24}
              />
              <Text style={[styles.label, focused && styles.labelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: palette.bg1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.hairline,
  },
  bar: {
    flexDirection: 'row',
    paddingTop: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  label: {
    ...typography.caption,
    color: palette.textFaint,
  },
  labelActive: {
    color: palette.text,
  },
});
