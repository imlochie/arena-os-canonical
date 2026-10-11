/**
 * LayerView — renders a single creative layer with direct-manipulation gestures
 * (drag to move, pinch to scale, rotate). Positions are stored normalised [0,1]
 * so a composition is resolution independent.
 *
 * This is a CapCut-style interaction: no modal dialogs, everything is on-canvas
 * and immediate.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { Layer } from '../../engine/types';
import { palette, radius } from '../../theme/tokens';

interface Props {
  layer: Layer;
  canvasWidth: number;
  canvasHeight: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Layer>) => void;
}

export function LayerView({
  layer,
  canvasWidth,
  canvasHeight,
  selected,
  onSelect,
  onChange,
}: Props) {
  // Shared values seed from the layer; committed back on gesture end.
  const tx = useSharedValue(layer.x * canvasWidth);
  const ty = useSharedValue(layer.y * canvasHeight);
  const scale = useSharedValue(layer.scale);
  const rotation = useSharedValue(layer.rotation);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startRot = useSharedValue(0);

  // Keep shared values in sync if the layer changes from outside (e.g. undo).
  tx.value = layer.x * canvasWidth;
  ty.value = layer.y * canvasHeight;
  scale.value = layer.scale;
  rotation.value = layer.rotation;

  const commit = (patch: Partial<Layer>) => onChange(patch);

  const pan = Gesture.Pan()
    .onBegin(() => {
      startX.value = tx.value;
      startY.value = ty.value;
      runOnJS(onSelect)();
    })
    .onUpdate((e) => {
      tx.value = startX.value + e.translationX;
      ty.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      runOnJS(commit)({
        x: tx.value / canvasWidth,
        y: ty.value / canvasHeight,
      } as Partial<Layer>);
    });

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      startScale.value = scale.value;
      runOnJS(onSelect)();
    })
    .onUpdate((e) => {
      scale.value = Math.max(0.2, Math.min(6, startScale.value * e.scale));
    })
    .onEnd(() => {
      runOnJS(commit)({ scale: scale.value } as Partial<Layer>);
    });

  const rotate = Gesture.Rotation()
    .onBegin(() => {
      startRot.value = rotation.value;
    })
    .onUpdate((e) => {
      rotation.value = startRot.value + (e.rotation * 180) / Math.PI;
    })
    .onEnd(() => {
      runOnJS(commit)({ rotation: rotation.value } as Partial<Layer>);
    });

  const tap = Gesture.Tap().onEnd(() => runOnJS(onSelect)());

  const gesture = Gesture.Simultaneous(pan, pinch, rotate, tap);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
      { rotateZ: `${rotation.value}deg` },
    ],
    opacity: layer.visible ? layer.opacity : 0,
  }));

  const content = useMemo(() => renderLayerContent(layer), [layer]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.layer, animStyle]}>
        <View style={[styles.inner, selected && styles.selected]}>{content}</View>
      </Animated.View>
    </GestureDetector>
  );
}

function renderLayerContent(layer: Layer): React.ReactNode {
  switch (layer.type) {
    case 'text':
      return (
        <Text
          style={{
            color: layer.color,
            fontSize: layer.fontSize,
            fontWeight: layer.fontWeight === 'bold' ? '700' : '400',
            textAlign: layer.align,
          }}
        >
          {layer.text}
        </Text>
      );
    case 'sticker':
      return <Text style={{ fontSize: layer.fontSize }}>{layer.glyph}</Text>;
    case 'shape':
      return (
        <View
          style={{
            width: layer.width * 200,
            height: layer.height * 200,
            backgroundColor: layer.color,
            borderRadius: layer.shape === 'ellipse' ? 999 : radius.sm,
          }}
        />
      );
    case 'image':
      return null; // image layers reserved for a later version
  }
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    // Anchor the transform origin at the layer's stored center.
    left: -100,
    top: -100,
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radius.sm,
  },
  selected: {
    borderColor: palette.accent,
    borderStyle: 'dashed',
  },
});
