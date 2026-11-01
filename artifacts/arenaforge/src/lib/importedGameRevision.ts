/** The head stays in revisionRollback for compatibility with older shelves. */
export type ImportedRevisionRollback = { source: string; savedAt: number; label?: string };
export const MAX_IMPORTED_REVISION_COPIES = 5;
export const MAX_IMPORTED_REVISION_BYTES = 18 * 1024 * 1024;
type RevisableGame = {
  source: string;
  revisionUndoSource?: string;
  revisionUndoLabel?: string;
  revisionLabel?: string;
  revisionRollback?: ImportedRevisionRollback;
  /** Older copies only: never duplicate the head's source bytes. */
  revisionHistory?: ImportedRevisionRollback[];
};
type RevisionResult<T extends RevisableGame> = Omit<T, "revisionUndoSource" | "revisionUndoLabel"> & RevisableGame;

export function getImportedRevisionHistory(game: RevisableGame): ImportedRevisionRollback[] {
  const seen = new Set([game.source]);
  return [...(game.revisionRollback ? [game.revisionRollback] : []), ...(game.revisionHistory ?? [])]
    .filter(copy => {
      if (seen.has(copy.source)) return false;
      seen.add(copy.source);
      return true;
    });
}

function withHistory<T extends RevisableGame>(game: T, copies: ImportedRevisionRollback[]): T {
  const seen = new Set([game.source]);
  const retained: ImportedRevisionRollback[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const copy of copies) {
    if (seen.has(copy.source)) continue;
    const size = encoder.encode(copy.source).byteLength;
    if (retained.length === MAX_IMPORTED_REVISION_COPIES || bytes + size > MAX_IMPORTED_REVISION_BYTES) break;
    seen.add(copy.source);
    bytes += size;
    retained.push(copy);
  }
  return { ...game, revisionRollback: retained[0], revisionHistory: retained.slice(1) };
}

export function importedRevisionMetadataValid(game: Partial<RevisableGame>, safeSource: (source: string) => boolean): boolean {
  const validLabel = (label: unknown) => label === undefined || (typeof label === "string" && label.length <= 120);
  const validCopy = (value: unknown): value is ImportedRevisionRollback => {
    if (!value || typeof value !== "object") return false;
    const copy = value as ImportedRevisionRollback;
    return typeof copy.source === "string" && safeSource(copy.source) &&
      typeof copy.savedAt === "number" && Number.isFinite(copy.savedAt) &&
      copy.savedAt >= 0 && copy.savedAt <= 8.64e15 && validLabel(copy.label);
  };
  if (!validLabel(game.revisionLabel) || !validLabel(game.revisionUndoLabel) ||
    (game.revisionRollback !== undefined && !validCopy(game.revisionRollback)) ||
    (game.revisionHistory !== undefined && (!Array.isArray(game.revisionHistory) ||
      game.revisionHistory.length > MAX_IMPORTED_REVISION_COPIES || !game.revisionHistory.every(validCopy)))) return false;
  const copies = [...(game.revisionRollback ? [game.revisionRollback] : []), ...(game.revisionHistory ?? [])];
  return copies.length <= MAX_IMPORTED_REVISION_COPIES &&
    copies.reduce((bytes, copy) => bytes + new TextEncoder().encode(copy.source).byteLength, 0) <= MAX_IMPORTED_REVISION_BYTES;
}

export function keepImportedRevision<T extends RevisableGame>(game: T, now = Date.now()): RevisionResult<T> {
  if (game.revisionUndoSource === undefined) return game;
  const { revisionUndoSource, revisionUndoLabel, ...kept } = game;
  return withHistory(kept, [
    { source: revisionUndoSource, savedAt: now, ...(revisionUndoLabel ? { label: revisionUndoLabel } : {}) },
    ...getImportedRevisionHistory(game),
  ]);
}

export function undoImportedRevision<T extends RevisableGame>(game: T): RevisionResult<T> {
  if (game.revisionUndoSource === undefined) return game;
  const { revisionUndoSource, revisionUndoLabel, ...previous } = game;
  return { ...previous, source: revisionUndoSource, revisionLabel: revisionUndoLabel };
}

export function restoreImportedRevision<T extends RevisableGame>(game: T, now = Date.now(), index = 0): RevisionResult<T> {
  const copies = getImportedRevisionHistory(game);
  const target = copies[index];
  if (game.revisionUndoSource !== undefined || !Number.isInteger(index) || !target) return game;
  return withHistory({ ...game, source: target.source, revisionLabel: target.label }, [
    { source: game.source, savedAt: now, ...(game.revisionLabel ? { label: game.revisionLabel } : {}) },
    ...copies.filter((_, position) => position !== index),
  ]);
}
