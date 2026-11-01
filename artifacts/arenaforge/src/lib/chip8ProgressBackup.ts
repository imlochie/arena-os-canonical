import { Chip8Runtime, isChip8Dialect, type Chip8Dialect, type Chip8Snapshot, type SuperChipSnapshot } from "./chip8Runtime";
export const MAX_CHIP8_BACKUP_BYTES = 256 * 1024;
export type Chip8ProgressState = Chip8Snapshot | SuperChipSnapshot;
export type Chip8ProgressTarget = { gameId: string; name: string; rom: ArrayBuffer; dialect: Chip8Dialect };
export type Chip8ProgressBackup = {
  format: "arenaforge-chip8-progress"; version: 1; gameId: string; name: string;
  romSha256: string; dialect: Chip8Dialect; runtimeVersion: 1 | 2;
  exportedAt: number; snapshot: Chip8ProgressState;
};
export const chip8StateKey = (id: string, dialect: Chip8Dialect) =>
  dialect === "schip" ? `arenaforge.schip-state.v2:${id}` : `arenaforge.chip8-state.v1:${id}`;
const runtimeVersion = (dialect: Chip8Dialect) => dialect === "schip" ? 2 : 1;
async function romDigest(rom: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", rom);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function validateChip8Progress(target: Chip8ProgressTarget, value: unknown): Chip8ProgressState {
  if (!value || typeof value !== "object") throw new Error("The snapshot is missing its runtime state.");
  // Reuse the interpreter's exact array/range/profile/version validation and
  // return a detached canonical snapshot, never mutate the running machine.
  return new Chip8Runtime(new Uint8Array(target.rom), value, target.dialect).snapshot();
}
export async function createChip8ProgressBackup(target: Chip8ProgressTarget, snapshot: unknown): Promise<Chip8ProgressBackup> {
  const checked = validateChip8Progress(target, snapshot);
  return {
    format: "arenaforge-chip8-progress", version: 1, gameId: target.gameId, name: target.name.slice(0, 256),
    romSha256: await romDigest(target.rom), dialect: target.dialect, runtimeVersion: runtimeVersion(target.dialect),
    exportedAt: Date.now(), snapshot: checked,
  };
}
export async function inspectChip8ProgressBackup(text: string, target: Chip8ProgressTarget) {
  if (new TextEncoder().encode(text).byteLength > MAX_CHIP8_BACKUP_BYTES) throw new Error("Snapshot files must be no larger than 256 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("This snapshot file is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This is not an Arena CHIP-8 snapshot.");
  const backup = value as Chip8ProgressBackup;
  if (backup.format !== "arenaforge-chip8-progress" || backup.version !== 1) throw new Error("Unsupported CHIP-8 snapshot file format or version.");
  if (!isChip8Dialect(backup.dialect) || backup.dialect !== target.dialect ||
    backup.runtimeVersion !== runtimeVersion(target.dialect)) throw new Error("This snapshot uses a different or unsupported runtime profile/version.");
  if (typeof backup.gameId !== "string" || !backup.gameId || backup.gameId.length > 256 ||
    typeof backup.name !== "string" || backup.name.length > 256 ||
    typeof backup.exportedAt !== "number" || !Number.isFinite(backup.exportedAt) || backup.exportedAt < 0 || backup.exportedAt > 8.64e15 ||
    typeof backup.romSha256 !== "string" || !/^[a-f0-9]{64}$/.test(backup.romSha256)) throw new Error("The snapshot's game identity, fingerprint or date is invalid.");
  if (backup.romSha256 !== await romDigest(target.rom)) throw new Error("This snapshot belongs to a different program. Import its matching ROM first.");
  if (!backup.snapshot || typeof backup.snapshot !== "object") throw new Error("The snapshot is missing its runtime state.");
  const snapshot = validateChip8Progress(target, backup.snapshot);
  return { backup: { ...backup, snapshot }, sameIdentity: backup.gameId === target.gameId };
}
