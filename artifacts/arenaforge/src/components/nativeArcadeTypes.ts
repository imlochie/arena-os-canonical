import type { ArcadeManifest, ArcadeHost } from "../lib/arcadeManifest";
export type NativeDescriptor = {
  id: string;
  version: string;
  kind: "game" | "runtime";
  license: string;
  downloadBytes: number;
  unpackedBytes: number;
  runtimes: string[];
};

export type NativeRun = {
  id: string;
  key: string;
  phase: string;
  logs: string[];
  gameplayVerified: false;
  profile?: string;
};

export type NativeSnapshot = {
  packages: {
    busy: boolean;
    catalog: NativeDescriptor[];
    packages: Record<string, { phase: string; detail?: string }>;
  };
  storage: {
    downloads: number | null;
    staging: number | null;
    installed: number | null;
    profiles: number | null;
    "build-cache": number | null;
    warning?: string;
    freeBytes: number;
    reserveBytes: number;
    budgetBytes: number;
  };
  requirements: {
    supportedHost: boolean;
    backend: string;
    verified: boolean;
    message: string;
    limits: Record<string, string | number>;
  };
  runs: NativeRun[];
  operation?: boolean;
  canCancel?: boolean;
  host: ArcadeHost;
  managedGames: ArcadeManifest[];
};

export type NativeArcadeBridge = {
  inspect(): Promise<NativeSnapshot>;
  probe(): Promise<NativeSnapshot>;
  install(key: string): Promise<NativeSnapshot>;
  launch(key: string): Promise<NativeSnapshot>;
  stop(runId: string): Promise<NativeSnapshot>;
  remove(key: string): Promise<NativeSnapshot>;
  cancel(): Promise<NativeSnapshot>;
};

export function getNativeBridge(): NativeArcadeBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { arenaNativeArcade?: NativeArcadeBridge }).arenaNativeArcade ?? null;
}

export const keyOf = (d: { id: string; version: string }) => `${d.id}@${d.version}`;

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "unknown";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
