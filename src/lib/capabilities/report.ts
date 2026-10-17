/**
 * Capability report: one READY / DEGRADED / UNAVAILABLE entry per dependency,
 * each with path, version, source and remediation. The builder is pure - the
 * caller supplies real probes - so the logic is testable without a machine.
 *
 * READY is only ever produced from a probe that actually exercised the thing.
 */

export type CapabilityStatus = "READY" | "DEGRADED" | "UNAVAILABLE";

export type CapabilityId =
  | "database"
  | "migrations"
  | "broker"
  | "ffmpeg"
  | "ffprobe"
  | "python"
  | "demucs"
  | "yt-dlp"
  | "local-ai-runtime"
  | "network-providers";

export interface ProbeResult {
  ok: boolean;
  /** ok but not at full function (e.g. system fallback, no keys). */
  degraded?: boolean;
  path?: string | null;
  version?: string | null;
  source?: string | null;
  reason: string;
  remediation?: string;
}

export interface CapabilityEntry {
  id: CapabilityId;
  status: CapabilityStatus;
  /** Optional capabilities never make the overall status UNAVAILABLE. */
  required: boolean;
  path: string | null;
  version: string | null;
  source: string | null;
  reason: string;
  remediation: string | null;
}

export interface CapabilityReport {
  overall: CapabilityStatus;
  capabilities: CapabilityEntry[];
  checkedAt: string;
}

export type CapabilityProbes = Record<CapabilityId, () => Promise<ProbeResult>>;

/** Required = Arena cannot do its core job without it. */
export const REQUIRED: Record<CapabilityId, boolean> = {
  database: true,
  migrations: true,
  broker: true,
  ffmpeg: true,
  ffprobe: true,
  python: false,
  demucs: false,
  "yt-dlp": false,
  "local-ai-runtime": false,
  "network-providers": false,
};

export async function buildCapabilityReport(probes: CapabilityProbes, now: () => Date = () => new Date()): Promise<CapabilityReport> {
  const ids = Object.keys(REQUIRED) as CapabilityId[];
  const capabilities = await Promise.all(
    ids.map(async (id): Promise<CapabilityEntry> => {
      let result: ProbeResult;
      try {
        result = await probes[id]();
      } catch (error) {
        result = { ok: false, reason: `probe threw: ${error instanceof Error ? error.message : String(error)}` };
      }
      const status: CapabilityStatus = !result.ok ? "UNAVAILABLE" : result.degraded ? "DEGRADED" : "READY";
      return {
        id,
        status,
        required: REQUIRED[id],
        path: result.path ?? null,
        version: result.version ?? null,
        source: result.source ?? null,
        reason: result.reason,
        remediation: status === "READY" ? null : (result.remediation ?? null),
      };
    }),
  );
  const requiredBad = capabilities.some((c) => c.required && c.status === "UNAVAILABLE");
  const anyDegradedOrBad = capabilities.some((c) => c.status === "DEGRADED" || (c.required && c.status !== "READY"));
  const overall: CapabilityStatus = requiredBad ? "UNAVAILABLE" : anyDegradedOrBad ? "DEGRADED" : "READY";
  return { overall, capabilities, checkedAt: now().toISOString() };
}
