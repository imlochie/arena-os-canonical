import type { ArcadeRepositoryProvenance } from "@workspace/api-client-react";

const markerId = "arena-repository-attribution";
function scriptTags() {
  return /<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
}
function attributes(text: string) {
  const values = new Map<string, string>();
  for (const match of text.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    // HTML uses the first occurrence of a duplicate attribute.
    const name = match[1].toLowerCase();
    if (!values.has(name)) values.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return values;
}
export function readRepositoryAttribution(source: string): ArcadeRepositoryProvenance | undefined {
  const records = [...source.matchAll(scriptTags())].filter(match => attributes(match[1]).get("id") === markerId);
  if (!records.length) return undefined;
  if (records.length !== 1) throw new Error("This game contains multiple repository attribution records. Import a file with one unambiguous source notice.");
  const record = records[0];
  if (attributes(record[1]).get("type")?.trim().toLowerCase() !== "application/json" || record[2].length > 1024 * 1024) {
    throw new Error("Repository attribution must be a bounded, inert JSON source notice.");
  }
  let value: unknown;
  try { value = JSON.parse(record[2]); } catch { throw new Error("This game's repository attribution is malformed. The game was not imported."); }
  if (!isRepositoryProvenance(value)) throw new Error("This game's repository attribution has an invalid source, revision or license.");
  return value;
}
export function resolveRepositoryAttribution(source: string, supplied?: ArcadeRepositoryProvenance) {
  const embedded = readRepositoryAttribution(source);
  if (embedded && supplied && (embedded.repository !== supplied.repository || embedded.revision !== supplied.revision ||
      embedded.sourceUrl !== supplied.sourceUrl || embedded.license.spdx !== supplied.license.spdx ||
      embedded.license.path !== supplied.license.path || embedded.license.text !== supplied.license.text)) {
    throw new Error("The game already declares a different source or license. Its existing attribution will not be overwritten.");
  }
  return supplied ?? embedded;
}
export const withoutRepositoryAttribution = (source: string) => source.replace(scriptTags(), (full, attrs, body) => {
  const tag = attributes(attrs);
  if (tag.get("id") !== markerId || tag.get("type")?.trim().toLowerCase() !== "application/json" || body.length > 1024 * 1024) return full;
  try { return isRepositoryProvenance(JSON.parse(body)) ? "" : full; } catch { return full; }
});
/** Keep the pinned license/source notice with source exports and prompt edits. */
export function withRepositoryAttribution(source: string, provenance?: ArcadeRepositoryProvenance) {
  provenance = resolveRepositoryAttribution(source, provenance);
  if (!provenance) return source;
  const clean = withoutRepositoryAttribution(source);
  const json = JSON.stringify(provenance).replace(/</g, "\\u003c");
  const notice = `<script type="application/json" id="arena-repository-attribution">${json}</script>`;
  return /<\/body\s*>/i.test(clean) ? clean.replace(/<\/body\s*>/i, () => `${notice}</body>`) : `${clean}\n${notice}`;
}

export function isRepositoryProvenance(value: unknown): value is ArcadeRepositoryProvenance {
  if (!value || typeof value !== "object") return false;
  const p = value as ArcadeRepositoryProvenance;
  return typeof p.repository === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(p.repository) &&
    ![".", ".."].includes(p.repository.split("/")[1]) &&
    typeof p.revision === "string" && /^[a-f0-9]{40}$/.test(p.revision) &&
    p.sourceUrl === `https://github.com/${p.repository}/tree/${p.revision}` &&
    typeof p.license?.spdx === "string" && p.license.spdx.length > 0 && p.license.spdx.length <= 64 &&
    typeof p.license?.path === "string" && p.license.path.length > 0 && p.license.path.length <= 1024 &&
    typeof p.license?.text === "string" && p.license.text.trim().length > 0 && p.license.text.length <= 128 * 1024;
}
