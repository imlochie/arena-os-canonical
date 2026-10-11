/**
 * Licenses — a readable, in-app list of the third-party components LUMA uses and
 * their licenses. The authoritative list also lives in THIRD_PARTY_LICENSES.md.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '../src/ui/components/IconButton';
import { THIRD_PARTY_COMPONENTS } from '../src/data/licenses';
import { palette, radius, spacing, typography } from '../src/theme/tokens';

export default function LicensesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <IconButton icon="close" onPress={() => router.back()} />
        <Text style={styles.title}>Licenses</Text>
        <View style={{ width: 46 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}>
        <Text style={styles.intro}>
          LUMA is built on permissively licensed open-source software. No proprietary
          assets or code from any commercial app are used.
        </Text>
        {THIRD_PARTY_COMPONENTS.map((c) => (
          <View key={c.name} style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.name}>{c.name}</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{c.license}</Text>
              </View>
            </View>
            <Text style={styles.purpose}>{c.purpose}</Text>
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
  intro: { ...typography.body, color: palette.textDim, marginBottom: spacing.lg },
  card: {
    backgroundColor: palette.bg1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { ...typography.heading, color: palette.text, flex: 1 },
  badge: {
    backgroundColor: palette.bg3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  badgeText: { ...typography.caption, color: palette.textDim },
  purpose: { ...typography.caption, color: palette.textFaint, marginTop: 6 },
});
