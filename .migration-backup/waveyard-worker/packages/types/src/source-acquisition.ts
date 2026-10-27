export const SOURCE_ACQUISITION_METHODS = ["local-upload", "authorized-url"] as const;
export type SourceAcquisitionMethod = (typeof SOURCE_ACQUISITION_METHODS)[number];
export const BUILD_STAGES = ["resolving-sources", "separating", "understanding", "finding-structure", "building", "ready", "failed"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export type SourceIntakeRequest = { localFileCount: number; urls: string[] };
export type SourceIntakeSummary = { requestedCount: number; distinctUrls: string[]; invalidUrls: string[] };

/** URL parsing only; acquisition remains an explicit server-side authorized resolver step. */
export function summariseSourceIntake(input: SourceIntakeRequest): SourceIntakeSummary {
  const localFileCount = Number.isInteger(input.localFileCount) && input.localFileCount > 0 ? input.localFileCount : 0;
  const seen = new Set<string>(); const distinctUrls: string[] = []; const invalidUrls: string[] = [];
  for (const raw of input.urls) {
    const value = raw.trim(); if (!value) continue;
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("unsupported");
      const canonical = url.toString();
      if (!seen.has(canonical)) { seen.add(canonical); distinctUrls.push(canonical); }
    } catch { invalidUrls.push(value); }
  }
  return { requestedCount: localFileCount + distinctUrls.length + invalidUrls.length, distinctUrls, invalidUrls };
}

export function buildStageFor(input: { acceptedSources: number; failedSources: number; processing: boolean; analysesReady: boolean; arrangementReady: boolean }): BuildStage {
  if (!input.acceptedSources) return "failed";
  if (input.processing) return "separating";
  if (!input.analysesReady) return "understanding";
  if (!input.arrangementReady) return "building";
  return "ready";
}
