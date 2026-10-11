/**
 * The shared markdown renderer (headings, bold, italic, code, code blocks,
 * lists, quotes, links, tables-lite, paragraphs).
 *
 * SECURITY: everything rendered here eventually lands in
 * dangerouslySetInnerHTML, so the renderer is written as an allowlist:
 *  - esc() escapes & < > " ' — attribute breakout via quotes is impossible;
 *  - safeUrl() is the only path into href/src: http(s)/mailto/relative only,
 *    control characters and scheme-relative URLs rejected (browsers strip
 *    \t/\n/\r inside URLs, which would otherwise smuggle "java\tscript:");
 *  - unsafe links render as their (escaped) literal text — never a link.
 *
 * Rendered markup must stay escaped-and-allowlisted, not
 * escaped-and-hoped. Tests: src/lib/markdown.test.ts.
 */

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const URL_REJECT = /["'<>\\\u0000-\u001f\u007f]/;

/** Escapes everything that can break out of text or attribute context. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allowlist gate for href/src values. Returns the safe URL or null when the
 * value must not become a link target.
 */
export function safeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Quotes, angles, backslash, or any control character: not a URL we want.
  if (URL_REJECT.test(trimmed)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (scheme !== null) {
    return SAFE_URL_SCHEMES.has(`${scheme[1].toLowerCase()}:`) ? trimmed : null;
  }
  // Scheme-relative ("//evil.com") inherits the page protocol — reject.
  return trimmed.startsWith("//") ? null : trimmed;
}

/** Inverse of esc() for the characters it touches — lets safeUrl judge the
 *  ORIGINAL url (esc already ran when the markdown was escaped). */
function unescapeForCheck(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function inline(s: string): string {
  let out = esc(s);
  // images ![a](u) → real responsive images (powers the Image Arena).
  // URLs are judged in their ORIGINAL form (quotes un-escaped first) and
  // re-escaped on the way out — a " inside a URL is rejected outright.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, url: string) => {
      const safe = safeUrl(unescapeForCheck(url));
      return safe === null
        ? alt
        : `<a href="${esc(safe)}" target="_blank" rel="noreferrer"><img src="${esc(safe)}" alt="${alt}" loading="lazy" class="md-img" /></a>`;
    },
  );
  // links — unsafe schemes render as literal (escaped) text
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text: string, url: string) => {
      const safe = safeUrl(unescapeForCheck(url));
      return safe === null ? text : `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${text}</a>`;
    },
  );
  // inline code
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold + italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // code fence
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`
      );
      continue;
    }
    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      blocks.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    // quote
    if (line.trim().startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    // hr
    if (/^(\*\*\*|---|___)\s*$/.test(line.trim())) {
      blocks.push("<hr/>");
      i++;
      continue;
    }
    // table (simple)
    if (line.includes("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1])) {
      const header = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter(Boolean));
        i++;
      }
      blocks.push(
        `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`
      );
      continue;
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
      continue;
    }
    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
      continue;
    }
    // blank
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph (join wrapped lines)
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^(\*\*\*|---|___)\s*$/.test(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return blocks.join("\n");
}
