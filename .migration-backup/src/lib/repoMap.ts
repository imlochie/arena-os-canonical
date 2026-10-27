/**
 * Repo map — Cursor-grade codebase context for every chat surface (#6/#7 of
 * the vibe-tools list). Walks the real source tree at runtime and produces a
 * compact, ground-truth map (paths, sizes, exports) that models can be
 * grounded in — no staleness, no hand-maintained lists.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type RepoFile = { path: string; loc: number; exports: string[] };

const ROOTS = ["src", "desktop", "scripts"] as const;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", "__pycache__", ".git"]);
const MAX_EXPORTS_PER_FILE = 16;
const MAX_FILES = 1500;

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|tsx|mjs|cjs)$/.test(entry.name)) out.push(full);
    if (out.length >= MAX_FILES) return;
  }
}

export async function buildRepoMap(repoRoot = process.cwd()): Promise<{ generatedAt: string; files: RepoFile[] }> {
  const paths: string[] = [];
  for (const root of ROOTS) await walk(join(repoRoot, root), paths);
  const files: RepoFile[] = [];
  for (const path of paths) {
    try {
      const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      if (content.length > 400_000) continue;
      const exports = [...content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z0-9_$]+)/g)]
        .map((m) => m[1])
        .slice(0, MAX_EXPORTS_PER_FILE);
      files.push({ path: relative(repoRoot, path).split(sep).join("/"), loc: content.split("\n").length, exports });
    } catch {
      /* unreadable file — skip */
    }
  }
  return { generatedAt: new Date().toISOString(), files };
}

/** Compact prompt form: one line per file, exports inline. */
export function repoMapToPrompt(map: { generatedAt: string; files: RepoFile[] }): string {
  const lines = map.files.map((f) => `- ${f.path} (${f.loc} lines)${f.exports.length ? `: ${f.exports.join(", ")}` : ""}`);
  return `REPO MAP (generated ${map.generatedAt}, ${map.files.length} files):\n${lines.join("\n")}`;
}
