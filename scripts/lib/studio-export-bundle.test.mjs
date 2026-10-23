import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createVerifiedZip } from '../../src/lib/waveyard/conversion/archive.ts';
import { readStudioExportBundle } from './studio-export-bundle.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture({ path = 'export.wav', sha256, omitRights = false, extra = false } = {}) {
  const audio = Buffer.from('controlled bytes; parser test, not decoded audio');
  const manifest = { format: 'waveyard-export-bundle-v1', exportJobId: 'job', remixVersionId: 'version', media: { path, format: path === 'export.mid' ? 'midi' : 'wav', bytes: audio.length, sha256: sha256 ?? hash(audio) }, attribution: { basis: 'saved-version', sources: [] } };
  const contents = [[path, audio], ...(!omitRights ? [['RIGHTS.txt', Buffer.from('Unknown rights — no permission inferred 🎵')]] : []), ['export-manifest.json', Buffer.from(JSON.stringify(manifest))], ...(extra ? [['other.txt', Buffer.from('unexpected')]] : [])];
  const archive = await createVerifiedZip(contents.map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes), open: async () => Readable.from([bytes]) })));
  try { return { bytes: await readFile(archive.path), audio }; } finally { await archive.dispose(); }
}
test('canonical WAV/MIDI bundles retain exact media, Unicode notices and pinned job/version identities', async () => {
  for (const path of ['export.wav', 'export.mid']) {
    const { bytes, audio } = await fixture({ path }), before = hash(bytes);
    const bundle = readStudioExportBundle(bytes, { jobId: 'job', versionId: 'version' });
    assert.deepEqual(bundle.media, audio); assert.match(bundle.rights, /🎵/); assert.equal(hash(bytes), before);
    assert.throws(() => readStudioExportBundle(bytes, { jobId: 'other' }), /corrupt/);
    assert.throws(() => readStudioExportBundle(bytes, { versionId: 'other' }), /corrupt/);
  }
});
test('reader refuses truncated, modified and extended archives without accepting partial data', async () => {
  const { bytes } = await fixture();
  for (const changed of [bytes.subarray(0, 20), bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from('trailer')])]) assert.throws(() => readStudioExportBundle(changed));
  const corrupt = Buffer.from(bytes); corrupt[60] ^= 1; assert.throws(() => readStudioExportBundle(corrupt));
  const impossible = Buffer.from(bytes); impossible.writeUInt32LE(0xfffffff0, bytes.length - 6); assert.throws(() => readStudioExportBundle(impossible));
});
test('valid ZIP CRC alone cannot certify a wrong media checksum or missing/extra notices', async () => {
  const wrongHash = await fixture({ sha256: '0'.repeat(64) }); assert.throws(() => readStudioExportBundle(wrongHash.bytes));
  const missing = await fixture({ omitRights: true }); assert.throws(() => readStudioExportBundle(missing.bytes));
  const extra = await fixture({ extra: true }); assert.throws(() => readStudioExportBundle(extra.bytes));
});
