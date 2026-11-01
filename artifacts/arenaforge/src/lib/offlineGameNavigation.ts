import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";

/** Preserve attribution text, not live navigation, in offline imported games.
 * This never authorizes remote resources; the existing safety policy still
 * validates the final bundled document and execution remains sandboxed. */
export function neutralizeOfflineNavigation(document: Document) {
  for (const element of Array.from(document.querySelectorAll("a, area"))) {
    element.removeAttribute("ping");
    const href = element.getAttribute("href");
    if (!href || href.startsWith("#")) continue;
    element.setAttribute("title", `${element.getAttribute("title") ?? ""} Original link (offline): ${href.slice(0, 1000)}`.trim());
    element.removeAttribute("href");
    element.removeAttribute("target");
    element.removeAttribute("download");
  }
}

export function prepareOfflineHtml(html: string): string {
  // Do not turn arbitrary text into an apparently complete HTML game.
  if (!/<html[\s>]|<!doctype\s+html|<body[\s>]/i.test(html)) return html;
  // DOMParser can load resources in some browsers. Preflight first, exempting
  // only navigation hrefs that will be removed, never src/CSS or active code.
  const preflight = html.replace(/<\s*(?:a|area)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
    tag => tag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""));
  if (importedHtmlSafetyIssue(preflight)) return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  neutralizeOfflineNavigation(document);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
