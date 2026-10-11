/**
 * A round, tactile icon button with press feedback + optional haptics.
 * Used across camera controls and editor toolbars.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { haptic } from '../haptics';
import { Icon, IconName } from './Icon';
import { palette, typography } from '../../theme/tokens';

interface Props {
  icon: IconName;
  onPress?: () => void;
  label?: string;
  size?: number;
  color?: string;
  disabled?: boolean;
  active?: boolean;
  variant?: 'ghost' | 'filled';
  style?: ViewStyle;
}

export function IconButton({
  icon,
  onPress,
  label,
  size = 46,
  color,
  disabled = false,
  active = false,
  variant = 'ghost',
  style,
}: Props) {
  const iconColor = disabled
    ? palette.textFaint
    : active
      ? palette.accent
      : (color ?? palette.text);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => {
          if (disabled) return;
          haptic('light');
          onPress?.();
        }}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={label ?? icon}
        accessibilityState={{ disabled, selected: active }}
        style={({ pressed }) => [
          styles.button,
          { width: size, height: size, borderRadius: size / 2 },
          variant === 'filled' && styles.filled,
          active && variant === 'filled' && styles.filledActive,
          pressed && !disabled && styles.pressed,
          style,
        ]}
      >
        <Icon name={icon} color={iconColor} size={size * 0.5} />
      </Pressable>
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 4 },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  filled: {
    backgroundColor: palette.bg3,
  },
  filledActive: {
    backgroundColor: palette.accentDim,
  },
  pressed: {
    opacity: 0.55,
    transform: [{ scale: 0.94 }],
  },
  label: {
    ...typography.caption,
    color: palette.textDim,
  },
});
