/** RFC 6266 / RFC 8187 attachment name: HTTP headers are byte strings, not
 * Unicode strings. Keep an ASCII fallback and preserve the portable UTF-8 name
 * in filename*. Strip controls and path separators from BOTH representations. */
export function attachmentDisposition(filename: string): string {
  const cleaned = filename.toWellFormed().replace(/[\p{Cc}/\\]/gu, "_");
  const safe = !cleaned || cleaned === "." || cleaned === ".." ? "download" : cleaned;
  const ascii = safe.replace(/[^\x20-\x7e]|"/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
