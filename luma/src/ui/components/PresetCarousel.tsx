/**
 * PresetCarousel — the horizontal, tactile preset selector used on Camera and
 * Edit. Fast, snappy, and shows the selected preset clearly.
 *
 * It is intentionally *presentational*: it takes a preset list + selection and
 * emits onSelect. Optionally renders a live per-item thumbnail preview when a
 * `thumbnailUri` is provided (Edit screen); on Camera it shows compact chips so
 * the live viewfinder stays the star.
 */

import React, { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { EMPTY_RECIPE, Preset } from '../../engine/types';
import { PhotoRenderer } from './PhotoRenderer';
import { haptic } from '../haptics';
import { palette, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  presets: Preset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** When set, each chip renders a live thumbnail of this image with the preset. */
  thumbnailUri?: string;
  variant?: 'chips' | 'thumbs';
}

const THUMB = 64;

interface Item {
  id: string | null;
  name: string;
  preset: Preset | null;
}

export function PresetCarousel({
  presets,
  selectedId,
  onSelect,
  thumbnailUri,
  variant = 'chips',
}: Props) {
  const data = useMemo<Item[]>(
    () => [
      { id: null, name: 'Original', preset: null },
      ...presets.map((p) => ({ id: p.id, name: p.name, preset: p })),
    ],
    [presets],
  );

  const renderItem = ({ item }: { item: Item }) => {
    const selected = item.id === selectedId;
    const showThumb = variant === 'thumbs' && !!thumbnailUri;

    return (
      <Pressable
        onPress={() => {
          haptic('selection');
          onSelect(item.id);
        }}
        style={styles.item}
        accessibilityRole="button"
        accessibilityLabel={item.name}
        accessibilityState={{ selected }}
      >
        {showThumb ? (
          <View
            style={[
              styles.thumbFrame,
              selected && styles.thumbFrameSelected,
            ]}
          >
            <PhotoRenderer
              uri={thumbnailUri!}
              recipe={{
                ...EMPTY_RECIPE,
                presetId: item.id,
                presetIntensity: item.preset?.defaultIntensity ?? 1,
              }}
              preset={item.preset}
              width={THUMB}
              height={THUMB}
              fit="cover"
            />
          </View>
        ) : (
          <View style={[styles.chip, selected && styles.chipSelected]}>
            <Text
              style={[styles.chipText, selected && styles.chipTextSelected]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
          </View>
        )}
        {showThumb ? (
          <Text
            style={[styles.thumbLabel, selected && styles.thumbLabelSelected]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  return (
    <FlatList
      horizontal
      data={data}
      keyExtractor={(i) => i.id ?? 'original'}
      renderItem={renderItem}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  item: {
    alignItems: 'center',
    gap: 6,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: palette.scrim,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  chipText: {
    ...typography.label,
    color: palette.text,
  },
  chipTextSelected: {
    color: palette.bg0,
  },
  thumbFrame: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbFrameSelected: {
    borderColor: palette.accent,
  },
  thumbLabel: {
    ...typography.caption,
    color: palette.textDim,
    maxWidth: THUMB + 12,
    textAlign: 'center',
  },
  thumbLabelSelected: {
    color: palette.text,
  },
});
