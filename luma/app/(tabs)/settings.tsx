/**
 * SETTINGS — image quality, save behavior, haptics, appearance, reset presets,
 * privacy info, version, and licenses. No accounts, no subscriptions, no
 * analytics, no cloud — everything is local (V1 principle).
 */

import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';

import { useSettingsStore } from '../../src/state/settingsStore';
import { presetRepository } from '../../src/ui/usePresets';
import { ExportQuality } from '../../src/storage/settings';
import { getEngine } from '../../src/engine';
import { palette, radius, spacing, typography } from '../../src/theme/tokens';

const QUALITY_OPTIONS: { id: ExportQuality; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'Up to 2048px · faster' },
  { id: 'high', label: 'High', hint: 'Up to 4096px · balanced' },
  { id: 'max', label: 'Max', hint: 'Full resolution · best quality' },
];

export default function SettingsTab() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [engineName] = useState(() => getEngine().capabilities.name);

  const version = Constants.expoConfig?.version ?? '0.1.0';

  const onResetPresets = useCallback(() => {
    Alert.alert(
      'Reset presets',
      'This removes any presets you created or duplicated and keeps the built-in library. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => presetRepository.resetToBuiltIns(),
        },
      ],
    );
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xxl }}
    >
      <Text style={styles.title}>Settings</Text>

      {/* Image quality */}
      <Section label="Image quality">
        {QUALITY_OPTIONS.map((opt) => (
          <Row
            key={opt.id}
            label={opt.label}
            hint={opt.hint}
            selected={settings.exportQuality === opt.id}
            onPress={() => update({ exportQuality: opt.id })}
          />
        ))}
      </Section>

      {/* Save behavior */}
      <Section label="Save behavior">
        <Row
          label="Save a copy"
          hint="Original photo is never modified"
          selected={settings.saveBehavior === 'saveCopy'}
          onPress={() => update({ saveBehavior: 'saveCopy' })}
        />
        <Row
          label="Save & share"
          hint="Save, then open the share sheet"
          selected={settings.saveBehavior === 'saveAndShare'}
          onPress={() => update({ saveBehavior: 'saveAndShare' })}
        />
      </Section>

      {/* Haptics */}
      <Section label="Feedback">
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Haptics</Text>
            <Text style={styles.rowHint}>Subtle vibration on controls</Text>
          </View>
          <Switch
            value={settings.haptics}
            onValueChange={(v) => update({ haptics: v })}
            trackColor={{ true: palette.accent, false: palette.bg3 }}
            thumbColor={palette.text}
          />
        </View>
      </Section>

      {/* Appearance */}
      <Section label="Appearance">
        <Row label="Dark" hint="LUMA is dark-first in this version" selected onPress={() => {}} />
      </Section>

      {/* Presets */}
      <Section label="Presets">
        <Pressable style={styles.row} onPress={onResetPresets}>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, { color: palette.danger }]}>Reset presets</Text>
            <Text style={styles.rowHint}>Restore the built-in library</Text>
          </View>
        </Pressable>
      </Section>

      {/* About */}
      <Section label="About">
        <InfoRow label="Version" value={version} />
        <InfoRow label="Image engine" value={engineName} />
        <Pressable style={styles.row} onPress={() => router.push('/licenses')}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Open-source licenses</Text>
            <Text style={styles.rowHint}>Third-party components</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <Pressable style={styles.row} onPress={() => router.push('/privacy')}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Privacy</Text>
            <Text style={styles.rowHint}>Your photos stay on your device</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0, paddingHorizontal: spacing.lg },
  title: { ...typography.display, color: palette.text, marginBottom: spacing.lg },
  section: { marginBottom: spacing.xl },
  sectionLabel: {
    ...typography.label,
    color: palette.textDim,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: palette.bg1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.hairline,
  },
  rowText: { flex: 1, paddingRight: spacing.md },
  rowLabel: { ...typography.body, color: palette.text },
  rowHint: { ...typography.caption, color: palette.textFaint, marginTop: 2 },
  rowValue: { ...typography.body, color: palette.textDim },
  chevron: { ...typography.title, color: palette.textFaint },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: palette.bg4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: palette.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.accent },
});
