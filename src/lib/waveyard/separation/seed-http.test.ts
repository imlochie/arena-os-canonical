/** Actual loopback HTTP and subprocess regression, never genuine model inference. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findMdxModel } from './mdx';
import { seedModelFile, getModelFileStatus } from './seed';

const bytes = randomBytes(2 * 1024 * 1024);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type RequestLog = { range: string | undefined; ifRange: string | undefined; sent: number };
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, log: RequestLog, index: number) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'wy-seed-http-'));
  const requests: RequestLog[] = [];
  const server = createServer((req, res) => {
    const log = { range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined, sent: 0 };
    requests.push(log);
    handler(req, res, log, requests.length - 1);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const spec = { ...findMdxModel('kim_vocal_2')!, file: 'fixture.onnx', sizeBytes: bytes.length, sha256: sha(bytes), sourceUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/model` };
  return { dir, spec, requests, partial: join(dir, '.download-fixture.onnx.tmp'), final: join(dir, 'fixture.onnx'),
    async close() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); } };
}
function full(res: ServerResponse, log: RequestLog, body = bytes, etag = '"v1"') {
  res.writeHead(200, { 'Content-Length': body.length, ETag: etag }); log.sent += body.length; res.end(body);
}
function interrupt(res: ServerResponse, log: RequestLog) {
  res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"v1"' });
  const prefix = bytes.subarray(0, 256 * 1024); res.write(prefix); log.sent += prefix.length;
  setTimeout(() => res.destroy(), 40);
}
function ranged(req: IncomingMessage, res: ServerResponse, log: RequestLog, wrong = false, etag = '"v1"') {
  const offset = Number(req.headers.range!.match(/\d+/)![0]);
  const body = bytes.subarray(offset);
  res.writeHead(206, { 'Content-Length': body.length, ETag: etag, 'Content-Range': `bytes ${offset + (wrong ? 1 : 0)}-${bytes.length - 1}/${bytes.length}` });
  log.sent += body.length; res.end(body);
}
async function installed(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await readFile(f.final), bytes);
  assert.equal((await getModelFileStatus(f.spec, f.dir)).provisioning.state, 'ready');
  console.log(JSON.stringify({ source: 'controlled-local-http', sha256: sha(await readFile(f.final)), bytes: bytes.length, transfers: f.requests }));
}

for (const mode of ['range', 'ignored', 'wrong-offset', 'changed-validator'] as const) {
  test(`HTTP interrupted transfer and ${mode} retry: byte-exact verified publication`, async () => {
    const f = await fixture((req, res, log, index) => {
      if (index === 0) interrupt(res, log);
      else if (req.headers.range && mode !== 'ignored') ranged(req, res, log, mode === 'wrong-offset', mode === 'changed-validator' ? '"v2"' : '"v1"');
      else full(res, log);
    });
    try {
      await assert.rejects(seedModelFile(f.spec, { dir: f.dir }), /interrupted/);
      const partial = await readFile(f.partial);
      assert.equal(partial.length, 256 * 1024); assert.deepEqual(partial, bytes.subarray(0, partial.length));
      const state = await getModelFileStatus(f.spec, f.dir);
      assert.equal(state.verified, false); assert.equal(state.provisioning.state, 'interrupted'); assert.equal(state.provisioning.partialBytes, partial.length);
      await seedModelFile(f.spec, { dir: f.dir });
      assert.equal(f.requests[1].range, `bytes=${partial.length}-`);
      assert.equal(f.requests[1].ifRange, '"v1"');
      if (mode === 'range') assert.equal(f.requests[1].sent, bytes.length - partial.length);
      if (mode === 'wrong-offset' || mode === 'changed-validator') { assert.equal(f.requests.length, 3); assert.equal(f.requests[2].range, undefined); }
      await installed(f);
    } finally { await f.close(); }
  });
}

test('HTTP complete install, concurrent callers, and valid installation surviving offline retry', async () => {
  const f = await fixture((_req, res, log) => full(res, log));
  try {
    const [a, b] = await Promise.all([seedModelFile(f.spec, { dir: f.dir }), seedModelFile(f.spec, { dir: f.dir })]);
    assert.equal(a.outcome, 'installed'); assert.equal(b.outcome, 'installed'); assert.equal(f.requests.length, 1);
    assert.equal((await seedModelFile(f.spec, { dir: f.dir, fetchImpl: async () => { throw new Error('offline'); } })).outcome, 'already-present');
    await installed(f);
  } finally { await f.close(); }
});

for (const mode of ['checksum', 'oversized', 'truncated', 'changed-representation'] as const) {
  test(`HTTP ${mode} rejected, subsequent retry verifies without incompatible append`, async () => {
    const f = await fixture((req, res, log, index) => {
      if (mode === 'changed-representation' && index === 0) { interrupt(res, log); return; }
      const badIndex = mode === 'changed-representation' ? 1 : 0;
      if (index !== badIndex) { full(res, log); return; }
      if (mode === 'truncated') { interrupt(res, log); return; }
      if (mode === 'oversized') { const body = Buffer.alloc(bytes.length * 2, 1); res.writeHead(200, { ETag: '"v1"' }); log.sent += body.length; res.end(body); return; }
      const corrupt = Buffer.from(bytes); corrupt[0] ^= 255;
      // Changed representation ignores If-Range and returns a new full entity.
      full(res, log, corrupt, '"v2"');
    });
    try {
      await assert.rejects(seedModelFile(f.spec, { dir: f.dir }));
      if (mode === 'changed-representation') await assert.rejects(seedModelFile(f.spec, { dir: f.dir }), /integrity check/);
      assert.equal((await getModelFileStatus(f.spec, f.dir)).verified, false);
      await assert.rejects(stat(f.final), /ENOENT/);
      await seedModelFile(f.spec, { dir: f.dir });
      await installed(f);
    } finally { await f.close(); }
  });
}

function child(f: Awaited<ReturnType<typeof fixture>>) {
  const process = fork(resolve('tests/fixtures/model-seed-child.mjs'), [JSON.stringify({ spec: f.spec, dir: f.dir })], { execArgv: ['--import', './scripts/register-src-loader.mjs'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; process.stdout!.on('data', (b) => { output += b; }); process.stderr!.on('data', (b) => { output += b; });
  const exit = once(process, 'exit');
  return { process, exit, output: () => output };
}

// 20 s was a hang guard, not a promise: nothing asserted that this finishes
// within it. On a 2-core Windows runner the test (one killed process, then two
// competing ones, each downloading through a 4 ms tick) exceeded it in run
// 39783929848 while passing in 39775173391 — the cap fired, no assertion did.
// The global per-test budget is the real bound; this stays as a local guard
// but above the work. Each phase logs first, so a future timeout names where.
test('SIGKILL restart resumes persisted prefix in a new process; competing process shares publication lock', { timeout: 120000 }, async () => {
  const f = await fixture((req, res, log) => {
    const offset = req.headers.range ? Number(req.headers.range.match(/\d+/)![0]) : 0;
    res.writeHead(offset ? 206 : 200, { 'Content-Length': bytes.length - offset, ETag: '"v1"', ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    let cursor = offset;
    const timer = setInterval(() => {
      const end = Math.min(cursor + 32768, bytes.length); log.sent += end - cursor; res.write(bytes.subarray(cursor, end)); cursor = end;
      if (cursor === bytes.length) { clearInterval(timer); res.end(); }
    }, 4);
    res.once('close', () => clearInterval(timer));
  });
  const children: ReturnType<typeof child>[] = [];
  try {
    console.log('[phase] first child: downloading prefix');
    const first = child(f); children.push(first);
    await new Promise<void>((resolve, reject) => {
      first.process.on('message', (message: { progress?: { bytes: number } }) => { if ((message.progress?.bytes ?? 0) >= 262144) resolve(); });
      first.process.once('exit', () => reject(new Error(`child exited before prefix: ${first.output()}`)));
    });
    console.log('[phase] first child: prefix reached, killing');
    first.process.kill('SIGKILL'); await first.exit;
    const prefix = await readFile(f.partial);
    assert.ok(prefix.length >= 262144 && prefix.length < bytes.length);
    assert.deepEqual(prefix, bytes.subarray(0, prefix.length));
    assert.equal((await getModelFileStatus(f.spec, f.dir)).provisioning.state, 'interrupted');
    console.log('[phase] two competing children: resume and lock');
    const second = child(f), competitor = child(f); children.push(second, competitor);
    const [secondExit, competitorExit] = await Promise.all([second.exit, competitor.exit]);
    assert.equal(secondExit[0], 0, second.output()); assert.equal(competitorExit[0], 0, competitor.output());
    assert.equal(f.requests.length, 2, 'one initial and exactly one resumed HTTP transfer across three processes');
    assert.equal(f.requests[1].range, `bytes=${prefix.length}-`);
    assert.equal(f.requests[1].sent, bytes.length - prefix.length);
    console.log(JSON.stringify({ killedPrefixBytes: prefix.length, resumedTransferBytes: f.requests[1].sent, finalSha256: sha(bytes) }));
    await installed(f);
  } finally { for (const c of children) if (c.process.exitCode === null && c.process.signalCode === null) c.process.kill('SIGKILL'); await f.close(); }
});

test('partial bytes from a different pinned revision are discarded; inference never sees partial', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = await fixture((_req, res, log) => { res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"v1"' }); res.write(bytes.subarray(0, 262144)); log.sent += 262144; void gate.then(() => { log.sent += bytes.length - 262144; res.end(bytes.subarray(262144)); }); });
  try {
    await writeFile(f.partial, Buffer.from('stale incompatible prefix'));
    await writeFile(join(f.dir, '.seed-fixture.onnx.json'), JSON.stringify({ revision: 'old', total: bytes.length, validator: '"v0"' }));
    let ready!: () => void;
    const prefixArrived = new Promise<void>((r) => { ready = r; });
    const downloading = seedModelFile(f.spec, { dir: f.dir, onProgress: () => ready() });
    await prefixArrived;
    const state = await getModelFileStatus(f.spec, f.dir);
    assert.equal(state.verified, false); assert.equal(state.provisioning.state, 'downloading');
    const { verifyModelFile } = await import('./session');
    await assert.rejects(verifyModelFile(f.spec, f.dir), /not present/);
    release(); await downloading;
    assert.equal(f.requests[0].range, undefined);
    await installed(f);
  } finally { release(); await f.close(); }
});

test('failed replacement revision never overwrites a valid installed model', async () => {
  const f = await fixture((_req, res, log) => full(res, log));
  try {
    await seedModelFile(f.spec, { dir: f.dir });
    const replacement = { ...f.spec, sha256: 'f'.repeat(64) };
    await assert.rejects(seedModelFile(replacement, { dir: f.dir }), /integrity check/);
    await installed(f);
    assert.equal((await getModelFileStatus(replacement, f.dir)).verified, false);
  } finally { await f.close(); }
});

test('explicit cancellation preserves bytes for a safe retry instead of becoming ready', async () => {
  const f = await fixture((req, res, log, index) => {
    if (index === 0) interrupt(res, log); else ranged(req, res, log);
  });
  try {
    const controller = new AbortController();
    await assert.rejects(seedModelFile(f.spec, { dir: f.dir, signal: controller.signal, onProgress: p => { if (p.bytes >= 262144) controller.abort(); } }), /interrupted/);
    const prefix = await readFile(f.partial);
    assert.equal(prefix.length, 262144); assert.deepEqual(prefix, bytes.subarray(0, prefix.length));
    assert.equal((await getModelFileStatus(f.spec, f.dir)).verified, false);
    await seedModelFile(f.spec, { dir: f.dir });
    assert.equal(f.requests[1].range, 'bytes=262144-');
    await installed(f);
  } finally { await f.close(); }
});

test('without a strong validator retry restarts safely rather than appending unvalidated bytes', async () => {
  const f = await fixture((_req, res, log, index) => {
    if (index > 0) { full(res, log); return; }
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: 'W/"weak"' });
    log.sent = 262144; res.write(bytes.subarray(0, 262144)); setTimeout(() => res.destroy(), 40);
  });
  try {
    await assert.rejects(seedModelFile(f.spec, { dir: f.dir }), /interrupted/);
    assert.equal((await readFile(f.partial)).length, 262144);
    await seedModelFile(f.spec, { dir: f.dir });
    assert.equal(f.requests[1].range, undefined);
    await installed(f);
  } finally { await f.close(); }
});

test('cancelling a joining caller does not report success or abort another caller transfer', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let arrived!: () => void;
  const prefix = new Promise<void>(r => { arrived = r; });
  const f = await fixture((_req, res, log) => {
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"v1"' }); log.sent = 262144; res.write(bytes.subarray(0, 262144));
    void gate.then(() => { log.sent += bytes.length - 262144; res.end(bytes.subarray(262144)); });
  });
  try {
    const original = seedModelFile(f.spec, { dir: f.dir, onProgress: () => arrived() });
    await prefix;
    const controller = new AbortController();
    const joining = seedModelFile(f.spec, { dir: f.dir, signal: controller.signal });
    controller.abort();
    await assert.rejects(joining, /cancelled/);
    assert.equal((await getModelFileStatus(f.spec, f.dir)).verified, false);
    release(); await original;
    assert.equal(f.requests.length, 1); await installed(f);
  } finally { release(); await f.close(); }
});
