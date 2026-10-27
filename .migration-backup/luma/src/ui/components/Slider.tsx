/**
 * A tactile, thumb-friendly slider built on the gesture handler + Reanimated.
 *
 * Supports bipolar (centered) tracks and reports both live drag values
 * (onChange, high-frequency) and a settle callback (onSettle, fired once on
 * release) so callers can drive live preview + a single undo step.
 */

import React, { useCallback } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { haptic } from '../haptics';
import { palette, radius, spacing, typography } from '../../theme/tokens';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  bipolar?: boolean;
  label?: string;
  /** Fired continuously while dragging (live preview). */
  onChange: (value: number) => void;
  /** Fired once when the drag ends (commit to history). */
  onSettle?: (value: number) => void;
  formatValue?: (value: number) => string;
}

const THUMB = 26;
const TRACK_H = 4;

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  bipolar = false,
  label,
  onChange,
  onSettle,
  formatValue,
}: SliderProps) {
  const width = useSharedValue(0);
  const startX = useSharedValue(0);

  const clampToStep = useCallback(
    (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      const snapped = Math.round(clamped / step) * step;
      return Math.min(max, Math.max(min, snapped));
    },
    [min, max, step],
  );

  const valueToX = (v: number, w: number) => {
    if (w <= 0) return 0;
    const t = (v - min) / (max - min);
    return t * (w - THUMB);
  };

  const xToValue = (x: number, w: number) => {
    if (w <= 0) return min;
    const t = x / (w - THUMB);
    return min + t * (max - min);
  };

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: valueToX(value, width.value) }],
  }));

  // Fill from center for bipolar, from left otherwise.
  const fillStyle = useAnimatedStyle(() => {
    const w = width.value;
    const x = valueToX(value, w) + THUMB / 2;
    if (bipolar) {
      const center = valueToX(0, w) + THUMB / 2;
      const left = Math.min(center, x);
      const fw = Math.abs(x - center);
      return { left, width: fw };
    }
    return { left: 0, width: x };
  });

  const pan = Gesture.Pan()
    .onBegin((e) => {
      startX.value = valueToX(value, width.value);
      const raw = xToValue(startX.value + e.translationX, width.value);
      runOnJS(onChange)(clampToStep(raw));
    })
    .onUpdate((e) => {
      const raw = xToValue(startX.value + e.translationX, width.value);
      runOnJS(onChange)(clampToStep(raw));
    })
    .onEnd((e) => {
      const raw = xToValue(startX.value + e.translationX, width.value);
      const v = clampToStep(raw);
      runOnJS(onChange)(v);
      if (onSettle) runOnJS(onSettle)(v);
      runOnJS(haptic)('selection');
    });

  const tap = Gesture.Tap().onEnd((e) => {
    const raw = xToValue(e.x - THUMB / 2, width.value);
    const v = clampToStep(raw);
    runOnJS(onChange)(v);
    if (onSettle) runOnJS(onSettle)(v);
    runOnJS(haptic)('selection');
  });

  const gesture = Gesture.Exclusive(pan, tap);

  const display = formatValue
    ? formatValue(value)
    : bipolar
      ? (value >= 0 ? '+' : '') + value.toFixed(2)
      : value.toFixed(2);

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.header}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{display}</Text>
        </View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <View style={styles.trackArea} onLayout={onLayout}>
          <View style={styles.track} />
          <Animated.View style={[styles.fill, fillStyle]} />
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  label: { ...typography.label, color: palette.textDim },
  value: { ...typography.mono, color: palette.text },
  trackArea: {
    height: THUMB + 8,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_H,
    borderRadius: radius.pill,
    backgroundColor: palette.bg3,
  },
  fill: {
    position: 'absolute',
    height: TRACK_H,
    borderRadius: radius.pill,
    backgroundColor: palette.accent,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: palette.text,
    borderWidth: 3,
    borderColor: palette.bg1,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
