/**
 * EDIT tab — the entry point for editing an existing photo.
 *
 * Keeps V1 simple: import a photo (permission requested on demand) which begins
 * an editing session and opens the full editor. Recent projects are listed so
 * the user can jump back into non-destructive edits.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { IconButton } from '../../src/ui/components/IconButton';
import { usePhotoImport } from '../../src/ui/usePhotoImport';
import { useEditorStore } from '../../src/state/editorStore';
import { EMPTY_RECIPE, Project } from '../../src/engine/types';
import { ProjectRepository } from '../../src/storage/projectRepository';
import { palette, radius, spacing, typography } from '../../src/theme/tokens';

const projectRepo = new ProjectRepository();

export default function EditTab() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { pick } = usePhotoImport();
  const beginSession = useEditorStore((s) => s.beginSession);
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(() => {
    projectRepo.list().then(setProjects).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);
  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const onImport = useCallback(async () => {
    const asset = await pick();
    if (!asset) return;
    beginSession(asset, {
      recipe: {
        ...EMPTY_RECIPE,
        adjustments: { ...EMPTY_RECIPE.adjustments },
        crop: { ...EMPTY_RECIPE.crop },
      },
    });
    router.push('/editor');
  }, [pick, beginSession, router]);

  const openProject = useCallback(
    (project: Project) => {
      beginSession(project.source, { recipe: project.recipe, canvas: project.canvas });
      router.push('/editor');
    },
    [beginSession, router],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.lg }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Edit</Text>
        <Text style={styles.subtitle}>Import a photo to start a non-destructive edit.</Text>
      </View>

      <Pressable style={styles.importCard} onPress={onImport}>
        <IconButton icon="image" size={56} variant="filled" onPress={onImport} />
        <Text style={styles.importText}>Import from Photos</Text>
      </Pressable>

      <Text style={styles.sectionLabel}>Recent projects</Text>
      {projects.length === 0 ? (
        <Text style={styles.empty}>No saved projects yet.</Text>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          numColumns={3}
          columnWrapperStyle={styles.grid}
          contentContainerStyle={styles.gridContent}
          renderItem={({ item }) => (
            <Pressable style={styles.tile} onPress={() => openProject(item)}>
              <ExpoImage
                source={{ uri: item.thumbnailUri ?? item.source.uri }}
                style={styles.tileImg}
                contentFit="cover"
              />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0, paddingHorizontal: spacing.lg },
  header: { marginBottom: spacing.xl },
  title: { ...typography.display, color: palette.text },
  subtitle: { ...typography.body, color: palette.textDim, marginTop: 4 },
  importCard: {
    backgroundColor: palette.bg1,
    borderRadius: radius.lg,
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: palette.hairline,
    borderStyle: 'dashed',
  },
  importText: { ...typography.heading, color: palette.text },
  sectionLabel: {
    ...typography.label,
    color: palette.textDim,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  empty: { ...typography.body, color: palette.textFaint },
  grid: { gap: spacing.sm },
  gridContent: { gap: spacing.sm },
  tile: {
    flex: 1 / 3,
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: palette.bg2,
  },
  tileImg: { width: '100%', height: '100%' },
});
