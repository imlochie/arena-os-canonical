/**
 * Frame-navigation policy — the pure gate the main process enforces on
 * will-navigate. The window may only show the Arena app origin (Phase 2)
 * and, during startup, the local splash page. Everything else is denied
 * and logged. Origin equality, never prefix matching.
 */

export interface FramePolicy {
  allowedOrigins: readonly string[];
  allowFileUrls?: boolean;
}

export function isAllowedFrameUrl(rawUrl: string, policy: FramePolicy): boolean {
  if (rawUrl.startsWith("file://")) return policy.allowFileUrls === true;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return policy.allowedOrigins.includes(parsed.origin);
}
