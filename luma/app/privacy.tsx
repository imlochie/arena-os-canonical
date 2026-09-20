/**
 * Privacy — a plain-language statement. V1 is local-only: no accounts, no cloud,
 * no analytics, no tracking. Photos never leave the device except through the
 * user's own explicit share action.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '../src/ui/components/IconButton';
import { palette, spacing, typography } from '../src/theme/tokens';

const POINTS = [
  'Your photos are processed entirely on your device.',
  'LUMA has no account system and no login.',
  'Nothing is uploaded to any server. There is no cloud sync.',
  'There is no analytics, tracking, or advertising SDK.',
  'Photos and camera access are only requested when you use those features.',
  'Editing is non-destructive — your original photos are never modified.',
  'Saving writes a new photo to your library; the original stays intact.',
];

export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <IconButton icon="close" onPress={() => router.back()} />
        <Text style={styles.title}>Privacy</Text>
        <View style={{ width: 46 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}>
        <Text style={styles.lead}>Everything stays on your iPhone.</Text>
        {POINTS.map((p) => (
          <View key={p} style={styles.point}>
            <View style={styles.dot} />
            <Text style={styles.pointText}>{p}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0, paddingHorizontal: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { ...typography.title, color: palette.text },
  lead: { ...typography.heading, color: palette.text, marginBottom: spacing.lg },
  point: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md, alignItems: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.accent, marginTop: 8 },
  pointText: { ...typography.body, color: palette.textDim, flex: 1, lineHeight: 21 },
});
