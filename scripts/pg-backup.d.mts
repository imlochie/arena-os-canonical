export function readDataDirVersion(dataDir: string): string | null;
export function postmasterAlive(dataDir: string, processExists?: (pid: number) => boolean): boolean;
export interface PgBackupManifest {
  tool: string;
  createdAt: string;
  source: string;
  destination: string;
  pgVersion: string;
  pgVersionSha256: string;
  fileCount: number;
  totalBytes: number;
  verified: { fileCountMatches: boolean; totalBytesMatches: boolean; pgVersionMatches: boolean };
  topLevel: string[];
}

export function createBackup(
  dataDir: string,
  outRoot: string,
  options?: { processExists?: (pid: number) => boolean; now?: () => Date },
): Promise<{ dest: string; manifest: PgBackupManifest }>;
export function verifyBackup(
  dest: string,
  processExists?: (pid: number) => boolean,
): Promise<{ ok: boolean; manifest: Record<string, unknown>; measured: { fileCount: number; totalBytes: number } }>;
