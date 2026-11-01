/** One kept predecessor, plus the existing temporary undo for an unkept edit. */
export type ImportedRevisionRollback = { source: string; savedAt: number };
type RevisableGame = {
  source: string;
  revisionUndoSource?: string;
  revisionRollback?: ImportedRevisionRollback;
};
type RevisionResult<T extends RevisableGame> = Omit<T, "revisionUndoSource"> & RevisableGame;

export function keepImportedRevision<T extends RevisableGame>(game: T, now = Date.now()): RevisionResult<T> {
  if (game.revisionUndoSource === undefined) return game;
  const { revisionUndoSource, ...kept } = game;
  return { ...kept, revisionRollback: { source: revisionUndoSource, savedAt: now } };
}

export function undoImportedRevision<T extends RevisableGame>(game: T): RevisionResult<T> {
  if (game.revisionUndoSource === undefined) return game;
  const { revisionUndoSource, ...previous } = game;
  return { ...previous, source: revisionUndoSource };
}

export function restoreImportedRevision<T extends RevisableGame>(game: T, now = Date.now()): RevisionResult<T> {
  if (game.revisionUndoSource !== undefined || !game.revisionRollback) return game;
  // Swap rather than discard the replaced source, making a restore reversible.
  return {
    ...game,
    source: game.revisionRollback.source,
    revisionRollback: { source: game.source, savedAt: now },
  };
}
