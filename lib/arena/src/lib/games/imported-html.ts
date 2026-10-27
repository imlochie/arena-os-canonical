const MAX_IMPORTED_HTML_BYTES = 6 * 1024 * 1024;

/** Safety policy for imported games, separate from the generated-game validator. */
export function importedHtmlSafetyIssue(html: string): string | null {
  if (!/<html[\s>]|<!doctype\s+html|<body[\s>]/i.test(html)) return "Choose a complete HTML game.";
  if (new TextEncoder().encode(html).byteLength > MAX_IMPORTED_HTML_BYTES) return "HTML files are limited to 6 MB.";

  const externalAttribute = /\b(?:src|srcset|href|action|poster|data)\s*=\s*(?:"\s*(?:https?:|\/\/|file:|ftp:)[^"]*"|'\s*(?:https?:|\/\/|file:|ftp:)[^']*'|(?:https?:|\/\/|file:|ftp:)[^\s>]+)/i;
  if (
    externalAttribute.test(html) ||
    /url\(\s*(['"]?)\s*(?:https?:|\/\/|file:)/i.test(html) ||
    /@import\s+(?:url\()?['"]?\s*(?:https?:|\/\/)/i.test(html)
  ) {
    return "This file references an external resource. Only offline game files are supported.";
  }
  if (
    /\b(?:src|srcset|poster|data)\s*=\s*(?:"(?!data:|blob:)[^"]*"|'(?!data:|blob:)[^']*'|(?!data:|blob:)[^\s>]+)/i.test(html) ||
    /\bhref\s*=\s*(?:"(?!#|data:|blob:)[^"]*"|'(?!#|data:|blob:)[^']*'|(?!#|data:|blob:)[^\s>]+)/i.test(html) ||
    /url\(\s*(?:"(?!data:|blob:)[^"]*"|'(?!data:|blob:)[^']*'|(?!data:|blob:)[^)"']+)\s*\)/i.test(html) ||
    /@import\b/i.test(html)
  ) {
    return "This file refers to another file. Import a ZIP so local game assets can be bundled.";
  }
  if (
    /<\s*(?:iframe|frame|object|embed|form|base)\b|<meta\b[^>]*http-equiv\s*=\s*(['"]?)refresh\1/i.test(html) ||
    /\b(?:fetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bEventSource\b|sendBeacon|importScripts|\bimport\s*\(|window\.open\s*\(|window\s*\.\s*(?:parent|top|opener)\b|\b(?:window\.)?location\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:=|\s*\())/i.test(html)
  ) {
    return "Network access, embedded documents, forms, redirects, and parent-window access are blocked.";
  }
  return null;
}

export function extractImportedHtml(raw: string): string | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? text;
  const start = candidate.search(/<!doctype\s+html|<html/i);
  const end = candidate.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) return null;
  return candidate.slice(start, end + "</html>".length);
}
