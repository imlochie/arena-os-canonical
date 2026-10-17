export function readDataDirVersion(dataDir: string): string | null;
export function postmasterAlive(dataDir: string, processExists?: (pid: number) => boolean): boolean;

export interface PgBackupFileEntry {
  kind: "file" | "symlink";
  bytes?: number;
  sha256?: string;
  target?: string;
}

export interface PgBackupManifest {
  tool: string;
  createdAt: string;
  source: string;
  destination: string;
  pgVersion: string;
  pgVersionSha256: string;
  fileCount: number;
  totalBytes: number;
  files: Record<string, PgBackupFileEntry>;
  tablespaces: string[];
  verified: {
    perFileMatches: boolean;
    fileCountMatches: boolean;
    totalBytesMatches: boolean;
    pgVersionMatches: boolean;
    mismatches: string[];
  };
  topLevel: string[];
}

export function hashTree(root: string): Promise<{ entries: Record<string, PgBackupFileEntry>; fileCount: number; totalBytes: number }>;

export function createBackup(
  dataDir: string,
  outRoot: string,
  options?: { processExists?: (pid: number) => boolean; now?: () => Date },
): Promise<{ dest: string; manifest: PgBackupManifest }>;

export function verifyBackup(
  dest: string,
): Promise<{ ok: boolean; manifest: PgBackupManifest; mismatches: string[]; measured: { fileCount: number; totalBytes: number } }>;

export function restoreBackup(
  backupDir: string,
  targetDir: string,
): Promise<{ target: string; fileCount: number; totalBytes: number; pgVersion: string }>;
