/** CSS @import accepts both quoted strings and unquoted url(...) references. */
export function archiveStylesheetImports(css: string) {
  return [...css.matchAll(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi)]
    .map(match => ({ statement: match[0], reference: match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], media: match[6].trim() }));
}
