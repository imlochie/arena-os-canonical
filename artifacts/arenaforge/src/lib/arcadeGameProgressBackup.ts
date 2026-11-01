export const ARCADE_SAVE_PREFIX = "arenaforge.game-save.v1:";
export const MAX_ARCADE_SAVE_BYTES = 64 * 1024;
export const MAX_ARCADE_SAVE_KEY_LENGTH = 256;
export const MAX_PROGRESS_BACKUP_BYTES = 256 * 1024;
export type GameSaveData = Record<string, string>;
type ProgressStorage = Pick<Storage, "getItem" | "setItem">;
export type ProgressBackupTarget = { id: string; name: string; source: string };
export type HtmlProgressBackup = {
  format: "arenaforge-html-progress";
  version: 1;
  gameId: string;
  gameName: string;
  sourceSha256: string;
  exportedAt: number;
  data: GameSaveData;
};
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export function validateGameSaveData(value: unknown): GameSaveData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup progress must be a map of text keys and values.");
  const result: GameSaveData = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > MAX_ARCADE_SAVE_KEY_LENGTH || typeof entry !== "string") {
      throw new Error("Backup progress contains an invalid key or non-text value.");
    }
    result[key] = entry;
  }
  if (bytes(JSON.stringify(result)) > MAX_ARCADE_SAVE_BYTES) throw new Error("Backup progress exceeds the 64 KiB save limit.");
  return result;
}

export async function progressSourceDigest(source: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createHtmlProgressBackup(target: ProgressBackupTarget, storage: ProgressStorage = localStorage): Promise<HtmlProgressBackup> {
  const raw = storage.getItem(`${ARCADE_SAVE_PREFIX}${target.id}`);
  const data = validateGameSaveData(raw === null ? {} : JSON.parse(raw));
  if (!Object.keys(data).length) throw new Error("This game has no saved progress to export yet.");
  return {
    format: "arenaforge-html-progress", version: 1, gameId: target.id,
    gameName: target.name.slice(0, 256), sourceSha256: await progressSourceDigest(target.source),
    exportedAt: Date.now(), data,
  };
}

export function parseHtmlProgressBackup(text: string): HtmlProgressBackup {
  if (bytes(text) > MAX_PROGRESS_BACKUP_BYTES) throw new Error("Progress backup files must be no larger than 256 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("This file is not valid JSON progress data."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This is not an Arena HTML progress backup.");
  const backup = value as HtmlProgressBackup;
  if (backup.format !== "arenaforge-html-progress" || backup.version !== 1) throw new Error("Unsupported progress backup format or version.");
  if (typeof backup.gameId !== "string" || !backup.gameId || backup.gameId.length > 256 ||
    typeof backup.gameName !== "string" || backup.gameName.length > 256 ||
    typeof backup.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(backup.sourceSha256) ||
    typeof backup.exportedAt !== "number" || !Number.isFinite(backup.exportedAt) || backup.exportedAt < 0 || backup.exportedAt > 8.64e15) {
    throw new Error("The backup has invalid game identity, source fingerprint or date.");
  }
  return { format: backup.format, version: backup.version, gameId: backup.gameId, gameName: backup.gameName,
    sourceSha256: backup.sourceSha256, exportedAt: backup.exportedAt, data: validateGameSaveData(backup.data) };
}

export async function inspectHtmlProgressBackup(text: string, target: ProgressBackupTarget, storage: ProgressStorage = localStorage) {
  const backup = parseHtmlProgressBackup(text);
  const sameIdentity = backup.gameId === target.id;
  const sameSource = backup.sourceSha256 === await progressSourceDigest(target.source);
  if (!sameIdentity && !sameSource) throw new Error("This backup belongs to a different game. Its identity and source do not match the selected game.");
  return { backup, sameIdentity, sameSource, expectedRaw: storage.getItem(`${ARCADE_SAVE_PREFIX}${target.id}`) };
}

/** One atomic localStorage write; reject stale previews and never touch source. */
export function commitHtmlProgressRestore(id: string, data: GameSaveData, expectedRaw: string | null, storage: ProgressStorage = localStorage) {
  const serialized = JSON.stringify(validateGameSaveData(data));
  const key = `${ARCADE_SAVE_PREFIX}${id}`;
  if (storage.getItem(key) !== expectedRaw) throw new Error("Progress changed after this backup was opened. Choose the file again before replacing it.");
  storage.setItem(key, serialized); // Quota/security failures propagate; no false success.
}
