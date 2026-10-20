/** Strict reader for Arena's canonical STORE ZIP delivery, not a generic ZIP
 * extractor. No dependency, filesystem paths, decompression or legal inference. */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
const fail = () => { throw new Error('Invalid or corrupt Studio export bundle; no audio or attribution was certified.'); };
export function readStudioExportBundle(value, expected = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const end = bytes.length - 22;
  if (end < 0 || bytes.length > 2 * 1024 ** 3 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0 || bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== 3 || bytes.readUInt16LE(end + 10) !== 3) fail();
  const central = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (central + centralSize !== end) fail();
  const decoder = new TextDecoder('utf-8', { fatal: true }), entries = new Map(), intervals = [];
  let position = central;
  for (let index = 0; index < 3; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50 || bytes.readUInt16LE(position + 8) !== 0x0808 || bytes.readUInt16LE(position + 10) !== 0 || bytes.readUInt16LE(position + 34) !== 0) fail();
    const size = bytes.readUInt32LE(position + 24), crc = bytes.readUInt32LE(position + 16), nameSize = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32), offset = bytes.readUInt32LE(position + 42);
    if (size !== bytes.readUInt32LE(position + 20) || position + 46 + nameSize + extra + comment > end || offset + 30 > central) fail();
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameSize), name = decoder.decode(nameBytes);
    if (!['export.wav', 'export.mid', 'RIGHTS.txt', 'export-manifest.json'].includes(name) || entries.has(name)) fail();
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== 0x0808 || bytes.readUInt16LE(offset + 8) !== 0 || bytes.readUInt16LE(offset + 26) !== nameSize) fail();
    const localNameEnd = offset + 30 + nameSize, start = localNameEnd + bytes.readUInt16LE(offset + 28), stop = start + size;
    if (localNameEnd > central || !bytes.subarray(offset + 30, localNameEnd).equals(nameBytes) || stop + 16 > central || bytes.readUInt32LE(stop) !== 0x08074b50 || bytes.readUInt32LE(stop + 4) !== crc || bytes.readUInt32LE(stop + 8) !== size || bytes.readUInt32LE(stop + 12) !== size) fail();
    const content = bytes.subarray(start, stop);
    if (crc32(content) !== crc || ((name === 'RIGHTS.txt' || name === 'export-manifest.json') && size > 4 * 1024 ** 2)) fail();
    entries.set(name, content); intervals.push([offset, stop + 16]);
    position += 46 + nameSize + extra + comment;
  }
  intervals.sort((a, b) => a[0] - b[0]);
  if (position !== end || intervals[0][0] !== 0 || intervals.at(-1)[1] !== central || intervals.some((span, index) => index && span[0] !== intervals[index - 1][1])) fail();
  const name = entries.has('export.wav') ? 'export.wav' : 'export.mid', media = entries.get(name);
  if (!media || !entries.has('RIGHTS.txt') || !entries.has('export-manifest.json')) fail();
  const manifest = JSON.parse(decoder.decode(entries.get('export-manifest.json'))), rights = decoder.decode(entries.get('RIGHTS.txt'));
  if (manifest.format !== 'waveyard-export-bundle-v1' || manifest.media?.path !== name || manifest.media?.format !== (name === 'export.wav' ? 'wav' : 'midi') || manifest.media?.bytes !== media.length || manifest.media?.sha256 !== createHash('sha256').update(media).digest('hex') || !rights.trim() || !Array.isArray(manifest.attribution?.sources) || !['saved-version', 'legacy-current-acquisition'].includes(manifest.attribution?.basis)) fail();
  if ((expected.jobId && expected.jobId !== manifest.exportJobId) || (expected.versionId && expected.versionId !== manifest.remixVersionId)) fail();
  return { media, manifest, rights };
}
