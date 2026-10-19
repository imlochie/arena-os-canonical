/** Actual seed/status handlers, PostgreSQL, HTTP bytes. Fixture bytes are NOT models. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MDX_MODELS } from './mdx';
import { missionPostgres } from '../../../../tests/helpers/mission-postgres';

test('four-stem target seed route installs all recipe prerequisites and exposes model-only readiness', async () => {
  const pg = await missionPostgres();
  const dir = await mkdtemp(join(tmpdir(), 'wy-recipe-route-'));
  const oldDb = process.env.DATABASE_URL, oldModels = process.env.WAVEYARD_MODELS_DIR;
  const originals = MDX_MODELS.map(spec => ({ ...spec }));
  let requests = 0;
  const payload = Buffer.alloc(2_000_000, 13);
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Length': payload.length, ETag: '"controlled-fixture"' }); res.end(payload); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.DATABASE_URL = pg.url;
  process.env.WAVEYARD_MODELS_DIR = dir;
  try {
    for (const spec of MDX_MODELS) Object.assign(spec, { sourceUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/${spec.id}`, sha256: createHash('sha256').update(payload).digest('hex'), sizeBytes: payload.length });
    const { POST } = await import('../../../app/api/waveyard/separation/models/[id]/seed/route');
    const { GET } = await import('../../../app/api/waveyard/separation/models/route');
    const before = await (await GET()).json();
    assert.ok(before.models.every((model: { ready: boolean }) => !model.ready));
    const result = await POST(new Request('http://arena.test/seed', { method: 'POST' }), { params: Promise.resolve({ id: 'stems_4' }) });
    assert.equal(result.status, 200);
    const json = await result.json();
    assert.equal(json.models.length, 4); assert.equal(json.requeued, 0); assert.equal(json.outcome, 'installed');
    assert.ok(json.models.every((model: { ready: boolean }) => model.ready)); assert.equal(requests, 4);
    const status = await (await GET()).json();
    assert.ok(status.models.every((model: { provisioning: { state: string } }) => model.provisioning.state === 'ready'));
    assert.equal(typeof status.mdxRuntime.available, 'boolean');
    const retry = await POST(new Request('http://arena.test/seed', { method: 'POST' }), { params: Promise.resolve({ id: 'stems_4' }) });
    assert.equal((await retry.json()).outcome, 'already-present'); assert.equal(requests, 4, 'verified recipe does not download again');
    const unknown = await POST(new Request('http://arena.test/seed', { method: 'POST' }), { params: Promise.resolve({ id: 'unregistered' }) });
    assert.equal(unknown.status, 404);
    const { pool } = await import('../../../db');
    await pool.end();
  } finally {
    MDX_MODELS.forEach((spec, i) => Object.assign(spec, originals[i]));
    if (oldDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDb;
    if (oldModels === undefined) delete process.env.WAVEYARD_MODELS_DIR; else process.env.WAVEYARD_MODELS_DIR = oldModels;
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await pg.close(); await rm(dir, { recursive: true, force: true });
  }
});
