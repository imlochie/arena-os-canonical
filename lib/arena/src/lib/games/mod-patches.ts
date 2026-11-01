export const PATCH_LIMIT = 64 * 1024 * 1024;
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
export function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function bounds(size: number) { if (!Number.isSafeInteger(size) || size < 0 || size > PATCH_LIMIT) throw new Error("Patch exceeds the 64 MiB output limit."); }
export function applyIps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  bounds(source.length);
  if (patch.length > 16 * 1024 * 1024 || new TextDecoder().decode(patch.slice(0, 5)) !== "PATCH") throw new Error("Invalid or oversized IPS patch.");
  let cursor = 5, size = source.length;
  const records: { offset: number; bytes?: Uint8Array; count: number; value?: number }[] = [];
  const read = () => { if (cursor >= patch.length) throw new Error("Truncated IPS patch."); return patch[cursor++]; };
  const u16 = () => read() * 256 + read();
  let ended = false;
  while (cursor < patch.length) {
    const offset = read() * 65536 + read() * 256 + read();
    if (offset === 0x454f46) { ended = true; break; }
    const count = u16();
    if (records.length >= 20000) throw new Error("Too many IPS records.");
    if (count) {
      if (cursor + count > patch.length) throw new Error("Truncated IPS record.");
      bounds(offset + count); size = Math.max(size, offset + count);
      records.push({ offset, count, bytes: patch.slice(cursor, cursor + count) }); cursor += count;
    } else {
      const run = u16(), value = read();
      if (!run) throw new Error("Empty IPS RLE record.");
      bounds(offset + run); size = Math.max(size, offset + run); records.push({ offset, count: run, value });
    }
  }
  if (!ended) throw new Error("Missing IPS EOF.");
  let truncate: number | undefined;
  if (cursor + 3 === patch.length) truncate = read() * 65536 + read() * 256 + read();
  if (cursor !== patch.length) throw new Error("Unexpected IPS trailing bytes.");
  const result = new Uint8Array(size); result.set(source);
  for (const record of records) record.bytes ? result.set(record.bytes, record.offset) : result.fill(record.value, record.offset, record.offset + record.count);
  if (truncate === undefined) return result;
  bounds(truncate); const resized = new Uint8Array(truncate); resized.set(result.subarray(0, truncate)); return resized;
}
export function applyBps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  bounds(source.length);
  if (patch.length < 16 || patch.length > 16 * 1024 * 1024 || new TextDecoder().decode(patch.slice(0, 4)) !== "BPS1") throw new Error("Invalid or oversized BPS patch.");
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength), end = patch.length - 12;
  if (crc32(patch.subarray(0, patch.length - 4)) !== view.getUint32(patch.length - 4, true)) throw new Error("BPS patch checksum mismatch.");
  if (crc32(source) !== view.getUint32(end, true)) throw new Error("BPS base checksum mismatch.");
  let cursor = 4;
  const integer = () => {
    let value = 0, shift = 1;
    for (let i = 0; i < 8; i++) {
      if (cursor >= end) throw new Error("Truncated BPS integer.");
      const byte = patch[cursor++]; value += (byte & 127) * shift;
      if (!Number.isSafeInteger(value)) throw new Error("BPS integer overflow.");
      if (byte & 128) return value;
      shift *= 128; value += shift;
    }
    throw new Error("BPS integer overflow.");
  };
  if (integer() !== source.length) throw new Error("BPS source length mismatch.");
  const size = integer(); bounds(size);
  const metadata = integer(); if (metadata > 16384 || cursor + metadata > end) throw new Error("Invalid BPS metadata length.");
  cursor += metadata;
  const result = new Uint8Array(size); let output = 0, sourceRelative = 0, targetRelative = 0;
  while (output < size) {
    const command = integer(), action = command % 4, length = Math.floor(command / 4) + 1;
    if (output + length > size) throw new Error("BPS command exceeds target.");
    if (action === 0) {
      if (output + length > source.length) throw new Error("BPS source read out of bounds.");
      result.set(source.subarray(output, output + length), output); output += length;
    } else if (action === 1) {
      if (cursor + length > end) throw new Error("BPS literal out of bounds.");
      result.set(patch.subarray(cursor, cursor + length), output); cursor += length; output += length;
    } else {
      const encoded = integer(), delta = Math.floor(encoded / 2) * (encoded % 2 ? -1 : 1);
      if (action === 2) {
        sourceRelative += delta;
        if (sourceRelative < 0 || sourceRelative + length > source.length) throw new Error("BPS source copy out of bounds.");
        result.set(source.subarray(sourceRelative, sourceRelative + length), output); sourceRelative += length; output += length;
      } else {
        targetRelative += delta;
        for (let n = 0; n < length; n++) {
          if (targetRelative < 0 || targetRelative >= output) throw new Error("BPS target copy must refer to already written bytes.");
          result[output++] = result[targetRelative++];
        }
      }
    }
  }
  if (cursor !== end || crc32(result) !== view.getUint32(end + 4, true)) throw new Error("BPS target checksum or command length mismatch.");
  return result;
}
