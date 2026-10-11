/**
 * Project persistence.
 *
 * Projects are the top-level unit of work (source asset + recipe + canvas). They
 * are stored as a single JSON index document keyed by id. Images themselves are
 * NOT stored here — projects reference the original by URI and the original is
 * never modified (non-destructive contract).
 *
 * The repository is pure logic over a KVStore, so it is fully unit-testable with
 * the in-memory store.
 */

import { EMPTY_CANVAS, EMPTY_RECIPE, Project, SourceAsset } from '../engine/types';
import { getKVStore, KVStore } from './kvStore';

const PROJECTS_KEY = 'luma.projects.v1';

interface ProjectIndex {
  schemaVersion: number;
  projects: Project[];
}

function now(): number {
  return Date.now();
}

export function makeProjectId(): string {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a fresh project for a source asset with a neutral recipe. */
export function createProject(source: SourceAsset, name?: string): Project {
  const t = now();
  return {
    id: makeProjectId(),
    name,
    source,
    recipe: { ...EMPTY_RECIPE, adjustments: { ...EMPTY_RECIPE.adjustments }, crop: { ...EMPTY_RECIPE.crop } },
    canvas: { ...EMPTY_CANVAS, layers: [] },
    createdAt: t,
    updatedAt: t,
  };
}

export class ProjectRepository {
  constructor(private store: KVStore = getKVStore()) {}

  private async readIndex(): Promise<ProjectIndex> {
    const raw = await this.store.getItem(PROJECTS_KEY);
    if (!raw) return { schemaVersion: 1, projects: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<ProjectIndex>;
      if (!parsed || !Array.isArray(parsed.projects)) {
        return { schemaVersion: 1, projects: [] };
      }
      return { schemaVersion: parsed.schemaVersion ?? 1, projects: parsed.projects };
    } catch {
      // Corrupt data: fail safe with an empty index rather than crashing.
      return { schemaVersion: 1, projects: [] };
    }
  }

  private async writeIndex(index: ProjectIndex): Promise<void> {
    await this.store.setItem(PROJECTS_KEY, JSON.stringify(index));
  }

  /** List projects, most recently updated first. */
  async list(): Promise<Project[]> {
    const index = await this.readIndex();
    return [...index.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Project | null> {
    const index = await this.readIndex();
    return index.projects.find((p) => p.id === id) ?? null;
  }

  /** Insert or update a project, bumping updatedAt. */
  async save(project: Project): Promise<Project> {
    const index = await this.readIndex();
    const updated: Project = { ...project, updatedAt: now() };
    const i = index.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) {
      index.projects[i] = updated;
    } else {
      index.projects.push(updated);
    }
    await this.writeIndex(index);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const index = await this.readIndex();
    index.projects = index.projects.filter((p) => p.id !== id);
    await this.writeIndex(index);
  }

  async clear(): Promise<void> {
    await this.store.removeItem(PROJECTS_KEY);
  }
}
