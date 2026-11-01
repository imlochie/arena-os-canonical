import type { ArcadeRepositoryProvenance } from "@workspace/api-client-react";

const attributionTag = /<script\b[^>]*\bid=["']arena-repository-attribution["'][^>]*>[\s\S]*?<\/script\s*>/gi;
export const withoutRepositoryAttribution = (source: string) => source.replace(attributionTag, "");
/** Keep the pinned license/source notice with source exports and prompt edits. */
export function withRepositoryAttribution(source: string, provenance?: ArcadeRepositoryProvenance) {
  if (!provenance) return source;
  const clean = withoutRepositoryAttribution(source);
  const json = JSON.stringify(provenance).replace(/</g, "\\u003c");
  const notice = `<script type="application/json" id="arena-repository-attribution">${json}</script>`;
  return /<\/body\s*>/i.test(clean) ? clean.replace(/<\/body\s*>/i, () => `${notice}</body>`) : `${clean}\n${notice}`;
}

export function isRepositoryProvenance(value: unknown): value is ArcadeRepositoryProvenance {
  if (!value || typeof value !== "object") return false;
  const p = value as ArcadeRepositoryProvenance;
  return typeof p.repository === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) &&
    typeof p.revision === "string" && /^[a-f0-9]{40}$/.test(p.revision) &&
    p.sourceUrl === `https://github.com/${p.repository}/tree/${p.revision}` &&
    typeof p.license?.spdx === "string" && typeof p.license?.path === "string" &&
    typeof p.license?.text === "string" && p.license.text.length <= 128 * 1024;
}
