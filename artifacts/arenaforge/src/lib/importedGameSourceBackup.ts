import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import { importedRevisionMetadataValid, type ImportedRevisionRollback } from "./importedGameRevision";
import { isRepositoryProvenance, resolveRepositoryAttribution } from "./importedRepositoryAttribution";
import type { ArcadeRepositoryProvenance } from "@workspace/api-client-react";

export const MAX_SOURCE_BACKUP_BYTES = 40 * 1024 * 1024;
export type SourceBackupGame = {
  id: string;
  name: string;
  kind: "html";
  source: string;
  addedAt: number;
  provenance?: ArcadeRepositoryProvenance;
  revisionUndoSource?: string;
  revisionUndoLabel?: string;
  revisionLabel?: string;
  revisionRollback?: ImportedRevisionRollback;
  revisionHistory?: ImportedRevisionRollback[];
};
export type ImportedSourceBackup = {
  format: "arenaforge-html-source";
  version: 1;
  exportedAt: number;
  game: SourceBackupGame;
};
const gameKeys = ["id", "name", "kind", "source", "addedAt", "provenance", "revisionUndoSource",
  "revisionUndoLabel", "revisionLabel", "revisionRollback", "revisionHistory"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Validate every source before returning any record to the shelf writer. Never execute imported bytes. */
export function parseImportedSourceBackup(text: string): ImportedSourceBackup {
  if (bytes(text) > MAX_SOURCE_BACKUP_BYTES) throw new Error("Source backups are limited to 40 MB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("This source backup is not valid JSON."); }
  if (!object(value) || value.format !== "arenaforge-html-source" || value.version !== 1 ||
      !timestamp(value.exportedAt) || Object.keys(value).some(key => !["format", "version", "exportedAt", "game"].includes(key)) ||
      !object(value.game)) throw new Error("Unsupported or malformed HTML source backup.");
  const g = value.game;
  if (Object.keys(g).some(key => !(gameKeys as readonly string[]).includes(key)) ||
      g.kind !== "html" || typeof g.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(g.id) ||
      typeof g.name !== "string" || !g.name.trim() || g.name.length > 255 || !timestamp(g.addedAt) ||
      typeof g.source !== "string" || (g.provenance !== undefined && !isRepositoryProvenance(g.provenance))) {
    throw new Error("The source backup has invalid game metadata.");
  }
  const game = g as SourceBackupGame;
  const safeSource = (source: string) => {
    const issue = importedHtmlSafetyIssue(source);
    if (issue) throw new Error(`Source backup rejected: ${issue}`);
    resolveRepositoryAttribution(source, game.provenance);
    return true;
  };
  safeSource(game.source);
  if (!importedRevisionMetadataValid(game, safeSource) ||
      (game.revisionUndoSource !== undefined &&
        (typeof game.revisionUndoSource !== "string" || !safeSource(game.revisionUndoSource)))) {
    throw new Error("The source backup has invalid or oversized revision copies.");
  }
  // Project only known source fields. In particular, storage revisions and gameplay saves never travel.
  const clean = Object.fromEntries(gameKeys.filter(key => game[key] !== undefined).map(key => [key, game[key]]));
  return { format: "arenaforge-html-source", version: 1, exportedAt: value.exportedAt as number, game: clean as SourceBackupGame };
}

export function createImportedSourceBackup(game: SourceBackupGame): string {
  const portable = Object.fromEntries(gameKeys.filter(key => game[key] !== undefined).map(key => [key, game[key]]));
  const text = JSON.stringify({ format: "arenaforge-html-source", version: 1, exportedAt: Date.now(), game: portable });
  parseImportedSourceBackup(text);
  return text;
}
