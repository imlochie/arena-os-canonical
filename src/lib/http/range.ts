/** A single HTTP bytes range. Multiple/malformed/unsatisfiable ranges are rejected
 * rather than silently returning different bytes. Decimal bounds use BigInt:
 * RFC 9110 permits arbitrarily large numerals, and suffix/end bounds must clamp
 * to the representation size before converting to filesystem offsets. */
export function parseByteRange(value: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === BigInt(0)) return "invalid";
    return { start: suffix >= total ? 0 : Number(total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - BigInt(1);
  if (start >= total || end < start) return "invalid";
  return { start: Number(start), end: Number(end >= total ? total - BigInt(1) : end) };
}
