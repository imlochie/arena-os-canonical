/**
 * Desktop runtime configuration — one module owns every runtime decision
 * (spec §8: no scattered process.platform hacks).
 *
 * Pure resolution + persistence of the local runtime secret (DB password).
 * Ports are picked by binding an ephemeral listener and are persisted so a
 * restart reuses the same values (upgrade compatibility; a stale port simply
 * re-picks). Everything the supervisor spawns is derived from this config.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ArenaDataDirs } from "../paths";

export interface EmbeddedPostgresLayout {
  /** Directory containing bin/, lib/, share/ for the platform package. */
  nativeDir: string;
  initdb: string;
  pgCtl: string;
  postgres: string;
  /** Library directory to put on LD_LIBRARY_PATH (Linux). */
  libDir: string;
  /** Directories to prepend to PATH (Windows). */
  windowsPathDirs: string[];
}

export type RuntimeServerMode =
  | {
      /** "packaged": Electron binary as Node (ELECTRON_RUN_AS_NODE) + server.js. */
      kind: "packaged";
      nodeBinary: string;
      serverScript: string;
    }
  | {
      /** "dev": next dev through the repo's Node. */
      kind: "dev";
      cwd: string;
      nodeBinary: string;
    };

export interface ArenaRuntimeConfig {
  dirs: ArenaDataDirs;
  host: string;
  port: number;
  database: {
    user: string;
    password: string;
    name: string;
    port: number;
    /** Unix-socket dir; null on Windows (TCP only). */
    socketDir: string | null;
    dataDir: string;
  };
  postgres: EmbeddedPostgresLayout;
  migrationsDir: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  storageDir: string;
  server: RuntimeServerMode;
  mode: "desktop";
}

const DB_PASSWORD_FILE = "db-password.json";
const RUNTIME_PORTS_FILE = "runtime-ports.json";

export interface RuntimeConfigInputs {
  platform?: string;
  dirs: ArenaDataDirs;
  /** Package root used to locate binary packages (repo root / resources). */
  appRoot: string;
  /** Node/Electron binary used to run the server (dev: process.execPath). */
  nodeBinary: string;
  serverMode?: "dev" | "packaged";
  /** Override for tests. */
  ephemeralPortPicker?: () => Promise<number>;
  fileExists?: (p: string) => boolean;
  now?: () => Date;
}

function readOrCreateJson<T>(file: string, create: () => T): T {
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      // fall through: recreate corrupt state files
    }
  }
  const value = create();
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return value;
}

export async function pickFreePort(host: string): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function resolveEmbeddedPostgres(platform: string, appRoot: string): EmbeddedPostgresLayout {
  // Packaged layout: extraResources/embedded-postgres/{bin,lib,share}.
  const bundled = path.join(appRoot, "embedded-postgres");
  if (existsSync(path.join(bundled, "bin"))) {
    return {
      nativeDir: bundled,
      initdb: path.join(bundled, "bin", platform === "win32" ? "initdb.exe" : "initdb"),
      pgCtl: path.join(bundled, "bin", platform === "win32" ? "pg_ctl.exe" : "pg_ctl"),
      postgres: path.join(bundled, "bin", platform === "win32" ? "postgres.exe" : "postgres"),
      libDir: path.join(bundled, "lib"),
      windowsPathDirs: platform === "win32" ? [path.join(bundled, "bin"), path.join(bundled, "lib")] : [],
    };
  }
  // Dev layout: the npm platform package under node_modules.
  const packageName = platform === "win32" ? "@embedded-postgres/windows-x64" : platform === "darwin" ? "@embedded-postgres/darwin-x64" : "@embedded-postgres/linux-x64";
  const nativeDir = path.join(appRoot, "node_modules", packageName, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) {
    throw new Error(
      `Embedded PostgreSQL binaries are not available (looked for ${nativeDir}). ` +
        `The desktop runtime requires the @embedded-postgres platform package for ${platform}.`,
    );
  }
  return {
    nativeDir,
    initdb: path.join(nativeDir, "bin", "initdb"),
    pgCtl: path.join(nativeDir, "bin", "pg_ctl"),
    postgres: path.join(nativeDir, "bin", "postgres"),
    libDir: path.join(nativeDir, "lib"),
    windowsPathDirs: [],
  };
}

function resolveInstallerBinary(platform: string, appRoot: string, tool: "ffmpeg" | "ffprobe"): string | null {
  // Packaged layout first: extraResources/bin/ffmpeg(.exe)
  const bundled = path.join(appRoot, "bin", platform === "win32" ? `${tool}.exe` : tool);
  if (existsSync(bundled)) return bundled;
  // Dev layout: @ffmpeg-installer / @ffprobe-installer platform packages
  // (layout: node_modules/@ffmpeg-installer/<platform>/ffmpeg).
  const binaryName = platform === "win32" ? `${tool}.exe` : tool;
  const platformPrefix = tool === "ffmpeg" ? "@ffmpeg-installer" : "@ffprobe-installer";
  const platformName = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const bin = path.join(appRoot, "node_modules", platformPrefix, `${platformName}-x64`, binaryName);
  return existsSync(bin) ? bin : null;
}

export async function resolveRuntimeConfig(inputs: RuntimeConfigInputs): Promise<ArenaRuntimeConfig> {
  const platform = inputs.platform ?? process.platform;
  const { dirs } = inputs;
  for (const dir of [dirs.runtime, dirs.logs, dirs.waveyard]) mkdirSync(dir, { recursive: true });

  const secretFile = path.join(dirs.runtime, DB_PASSWORD_FILE);
  const secret = readOrCreateJson<{ password: string }>(secretFile, () => ({ password: randomBytes(24).toString("hex") }));

  const pickPort = inputs.ephemeralPortPicker ?? (() => pickFreePort("127.0.0.1"));
  const portsFile = path.join(dirs.runtime, RUNTIME_PORTS_FILE);
  let ports = readOrCreateJson<{ server: number | null; database: number | null }>(portsFile, () => ({ server: null, database: null }));
  if (ports.server === null) {
    ports = { ...ports, server: await pickPort() };
    writeFileSync(portsFile, JSON.stringify(ports), { mode: 0o600 });
  }
  if (ports.database === null) {
    ports = { ...ports, database: await pickPort() };
    writeFileSync(portsFile, JSON.stringify(ports), { mode: 0o600 });
  }

  const postgres = resolveEmbeddedPostgres(platform, inputs.appRoot);
  const serverMode = inputs.serverMode ?? "dev";
  const server: RuntimeServerMode =
    serverMode === "packaged"
      ? { kind: "packaged", nodeBinary: inputs.nodeBinary, serverScript: path.join(inputs.appRoot, "server", "server.js") }
      : { kind: "dev", cwd: inputs.appRoot, nodeBinary: inputs.nodeBinary };

  return {
    dirs,
    host: "127.0.0.1",
    port: ports.server!,
    database: {
      user: "arena",
      password: secret.password,
      name: "arena",
      port: ports.database!,
      socketDir: platform === "win32" ? null : path.join(dirs.runtime, "pg-sockets"),
      dataDir: path.join(dirs.data, "postgres"),
    },
    postgres,
    migrationsDir: path.join(inputs.appRoot, "desktop-migrations"),
    ffmpegPath: resolveInstallerBinary(platform, inputs.appRoot, "ffmpeg"),
    ffprobePath: resolveInstallerBinary(platform, inputs.appRoot, "ffprobe"),
    storageDir: path.join(dirs.waveyard, "storage"),
    server,
    mode: "desktop",
  };
}
