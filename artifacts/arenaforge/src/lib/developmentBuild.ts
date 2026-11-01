import { parse } from "acorn";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";

/** Parse, never evaluate. Manual development remains offline and CSP-safe. */
export function validateDevelopmentSource(original: string, draft: string) {
  const diagnostics: string[] = [];
  if (new TextEncoder().encode(draft).length > 50_000) diagnostics.push("Development source exceeds 50 KB.");
  if (importedHtmlSafetyIssue(draft)) diagnostics.push("Offline HTML safety validation failed.");
  const scripts = [...draft.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (!scripts.length) diagnostics.push("No executable game script was found.");
  let index = 0;
  for (const match of scripts) {
    if (/\btype\s*=\s*["'](?:application\/(?:ld\+)?json|text\/plain)["']/i.test(match[1])) continue;
    try { parse(match[2], { ecmaVersion: "latest", sourceType: "script" }); }
    catch { diagnostics.push(`Inline script ${++index} failed JavaScript syntax validation.`); continue; }
    index++;
  }
  if (original === draft) diagnostics.push("No gameplay source changes have been made.");
  return { ok: diagnostics.length === 0, diagnostics };
}
