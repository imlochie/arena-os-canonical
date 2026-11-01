export type SourceComparisonRow = {
  kind: "same" | "removed" | "added" | "gap";
  text: string;
  beforeLine?: number;
  afterLine?: number;
};
export const SOURCE_COMPARISON_CHAR_LIMIT = 120_000;
export const SOURCE_COMPARISON_ROW_LIMIT = 300;
const MAX_DIFF_CELLS = 250_000;

/** Read-only, bounded display. Never parses/executes source or uses the network. */
export function compareImportedGameSource(previous: string, current: string) {
  const identical = previous === current;
  const assets = new Map<string, number>();
  const prepare = (source: string) => source.replace(
    /data:[^,'"\s<>]+;base64,[A-Za-z0-9+/=]+/gi,
    data => {
      if (!assets.has(data)) assets.set(data, assets.size + 1);
      // Shared exact-value mapping: changed media cannot look unchanged just
      // because it occupies the same position or has the same byte count.
      return `${data.slice(0, data.indexOf(",") + 1)}[embedded data #${assets.get(data)}; ${data.length} characters]`;
    },
  ).replace(/\r\n?/g, "\n");
  const before = prepare(previous);
  const after = prepare(current);
  let firstChange = 0;
  while (firstChange < Math.min(before.length, after.length) && before[firstChange] === after[firstChange]) firstChange++;
  const start = Math.max(0, firstChange - 500);
  const cropSource = Math.max(before.length, after.length) > SOURCE_COMPARISON_CHAR_LIMIT;
  const excerpt = (text: string) => {
    const cropped = cropSource;
    const offset = cropped ? start : 0;
    let line = 1;
    for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === "\n") line++;
    return { lines: text.slice(offset, cropped ? offset + SOURCE_COMPARISON_CHAR_LIMIT : undefined).split("\n"), line, cropped };
  };
  const a = excerpt(before);
  const b = excerpt(after);
  let prefix = 0;
  while (prefix < Math.min(a.lines.length, b.lines.length) && a.lines[prefix] === b.lines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(a.lines.length, b.lines.length) - prefix &&
    a.lines[a.lines.length - 1 - suffix] === b.lines[b.lines.length - 1 - suffix]) suffix++;
  const left = a.lines.slice(prefix, a.lines.length - suffix);
  const right = b.lines.slice(prefix, b.lines.length - suffix);
  const rows: SourceComparisonRow[] = [];
  const same = (i: number, j: number) => rows.push({ kind: "same", text: a.lines[i], beforeLine: a.line + i, afterLine: b.line + j });
  if (prefix > 3) rows.push({ kind: "gap", text: `${prefix - 3} unchanged lines` });
  for (let i = Math.max(0, prefix - 3); i < prefix; i++) same(i, i);
  const coarse = (left.length + 1) * (right.length + 1) > MAX_DIFF_CELLS;
  const removed = (i: number) => rows.push({ kind: "removed", text: left[i], beforeLine: a.line + prefix + i });
  const added = (j: number) => rows.push({ kind: "added", text: right[j], afterLine: b.line + prefix + j });
  if (coarse) {
    left.forEach((_, i) => removed(i));
    right.forEach((_, j) => added(j));
  } else {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        table[i * width + j] = left[i] === right[j] ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        same(prefix + i++, prefix + j++);
      } else if (i < left.length && (j === right.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        removed(i++);
      } else added(j++);
    }
  }
  for (let i = 0; i < Math.min(suffix, 3); i++) same(a.lines.length - suffix + i, b.lines.length - suffix + i);
  if (suffix > 3) rows.push({ kind: "gap", text: `${suffix - 3} unchanged lines` });
  // Collapse long unchanged runs between separate edits as well.
  const compact: SourceComparisonRow[] = [];
  for (let i = 0; i < rows.length;) {
    let end = i;
    while (end < rows.length && rows[end].kind === "same") end++;
    if (end - i > 8) {
      compact.push(...rows.slice(i, i + 3), { kind: "gap", text: `${end - i - 6} unchanged lines` }, ...rows.slice(end - 3, end));
    } else if (end > i) compact.push(...rows.slice(i, end));
    else { compact.push(rows[i]); end++; }
    i = end;
  }
  const clippedRows = compact.length > SOURCE_COMPARISON_ROW_LIMIT;
  const shown = clippedRows
    ? [...compact.slice(0, SOURCE_COMPARISON_ROW_LIMIT / 2 - 1),
      { kind: "gap" as const, text: `${compact.length - SOURCE_COMPARISON_ROW_LIMIT + 2} comparison rows omitted` },
      ...compact.slice(-(SOURCE_COMPARISON_ROW_LIMIT / 2 - 1))]
    : compact;
  return {
    identical, rows: shown, embeddedAssets: assets.size, coarse,
    truncated: a.cropped || b.cropped || clippedRows,
    displayIdentical: before === after,
    added: shown.filter(row => row.kind === "added").length,
    removed: shown.filter(row => row.kind === "removed").length,
  };
}
