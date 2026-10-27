/**
 * CameraSelector — the swipeable five-camera chooser for the viewfinder.
 *
 * Product idea: the user is choosing a *camera*, not a filter. This is a
 * snap-scrolling horizontal strip of camera "cards" (number + name). The
 * centered card is the active camera; selecting it changes the viewfinder
 * identity. It's a FlatList with paging-like snap for a tactile feel.
 *
 * Presentational only — it reports the selected camera id upward.
 */

import React, { useCallback, useRef } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { Camera } from '../../cameras/catalog';
import { haptic } from '../haptics';
import { palette, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  cameras: Camera[];
  selectedId: string;
  onSelect: (camera: Camera) => void;
  /** Item width; the strip snaps to this. */
  itemWidth?: number;
  screenWidth: number;
  /** The user's most recent photo, used as a live look-preview surface. */
  previewUri?: string | null;
}

export function CameraSelector({
  cameras,
  selectedId,
  onSelect,
  itemWidth = 128,
  screenWidth,
  previewUri,
}: Props) {
  const listRef = useRef<FlatList<Camera>>(null);
  const sidePad = Math.max(0, (screenWidth - itemWidth) / 2);
  const selectedIndex = Math.max(0, cameras.findIndex((c) => c.id === selectedId));

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const index = Math.round(x / itemWidth);
      const cam = cameras[Math.min(cameras.length - 1, Math.max(0, index))];
      if (cam && cam.id !== selectedId) {
        haptic('selection');
        onSelect(cam);
      }
    },
    [cameras, itemWidth, onSelect, selectedId],
  );

  const scrollToIndex = (index: number) => {
    listRef.current?.scrollToOffset({ offset: index * itemWidth, animated: true });
  };

  const renderItem = ({ item, index }: { item: Camera; index: number }) => {
    const active = item.id === selectedId;
    return (
      <Pressable
        onPress={() => {
          haptic('selection');
          onSelect(item);
          scrollToIndex(index);
        }}
        style={[styles.card, { width: itemWidth }]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${item.name} camera. ${item.tagline}`}
      >
        {previewUri ? (
          <ExpoImage source={{ uri: previewUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : null}
        <View style={[StyleSheet.absoluteFill, styles.cardShade, active && styles.cardShadeActive]} />
        <Text style={[styles.number, active && styles.numberActive]}>{item.number}</Text>
        <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[styles.tagline, active && styles.taglineActive]} numberOfLines={1}>
          {item.tagline}
        </Text>
      </Pressable>
    );
  };

  return (
    <View>
      <FlatList
        ref={listRef}
        horizontal
        data={cameras}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        snapToInterval={itemWidth}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: sidePad }}
        onMomentumScrollEnd={onMomentumEnd}
        getItemLayout={(_, index) => ({
          length: itemWidth,
          offset: itemWidth * index,
          index,
        })}
        initialScrollIndex={selectedIndex}
      />
      {/* Center indicator tick */}
      <View pointerEvents="none" style={styles.tick} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: radius.md,
    minHeight: 76,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    gap: 1,
  },
  cardShade: { backgroundColor: 'rgba(0,0,0,0.58)' },
  cardShadeActive: { backgroundColor: 'rgba(0,0,0,0.38)' },
  number: { ...typography.caption, color: palette.textFaint },
  numberActive: { color: palette.accent },
  name: { ...typography.heading, color: palette.textDim },
  nameActive: { color: palette.text },
  tagline: { ...typography.caption, color: palette.textFaint },
  taglineActive: { color: palette.textDim },
  tick: {
    alignSelf: 'center',
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: palette.accent,
    marginTop: spacing.xs,
  },
});
