#!/usr/bin/env node
/** Reproducible full source suite. Never connects to or migrates a developer DB.
 * Serial test files: legacy PG fixtures truncate common tables. Each invocation
 * owns a fresh embedded cluster and applies the canonical desktop migrations.
 * Raw TAP is inherited; exit status is the child's, including startup failures.
 */
import { computeSourceIdentity } from './lib/staged-identity.mjs';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { prepareInstalledNativeTools } from './lib/installed-tool-preparation.mjs';
import { missionPostgres } from '../tests/helpers/mission-postgres.ts';
const started = Date.now();
const identity = computeSourceIdentity(process.cwd());
const head = identity.commit;
let pg;
let child;
let signal;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
  signal = name;
  if (child) child.kill(name);
});
let code = 1;
const evidence = path.resolve(process.env.ARENA_SOURCE_EVIDENCE_DIR ?? '.data/acceptance/source-suite');
await mkdir(evidence, { recursive: true });
const runId = `${new Date(started).toISOString().replaceAll(':', '-')}-${process.pid}`;
const tapPath = path.join(evidence, `${runId}.tap`);
const receiptPath = path.join(evidence, `${runId}.json`);
const receipt = { runId, startedAt: new Date(started).toISOString(), command: 'npm test', identity, phase: 'starting', tapPath };
async function checkpoint(fields) {
  Object.assign(receipt, fields);
  await writeFile(`${receiptPath}.tmp`, JSON.stringify(receipt, null, 2));
  await rename(`${receiptPath}.tmp`, receiptPath);
}
let tap;
await checkpoint({});
try {
  prepareInstalledNativeTools(process.cwd());
  pg = await missionPostgres();
  if (signal) throw new Error(`Interrupted during database startup (${signal})`);
  console.error(`[source-suite] head=${head} sourceDigest=${identity.sourceDigest}; fresh PostgreSQL with canonical migrations; serial test files`);
  await checkpoint({ phase: 'testing', database: 'owned embedded PostgreSQL; canonical desktop migrations' });
  tap = createWriteStream(tapPath);
  // A test that blocks forever must become a recorded failure, not a stalled
  // job. The bound is per test and generous (3 minutes); it is not a way to
  // hide slow work — every affected test is named in the TAP output.
  const testTimeout = process.env.ARENA_TEST_TIMEOUT_MS;
  const timeoutArgs = testTimeout ? [`--test-timeout=${testTimeout}`] : [];
  child = spawn(process.execPath, ['--import', './scripts/register-src-loader.mjs', '--test', '--test-concurrency=1', ...timeoutArgs, 'src/**/*.test.ts', 'desktop/**/*.test.ts', 'scripts/lib/*.test.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: pg.url },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(tap, { end: false });
  child.stderr.pipe(tap, { end: false });
  tap.on('error', error => { console.error('[source-suite] cannot retain TAP:', error); child.kill(); });
  code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
} catch (error) {
  console.error('[source-suite]', error);
} finally {
  try { await pg?.close(); } catch (error) { console.error('[source-suite] cleanup failed:', error); code = 1; }
  if (signal) code = 1;
  const endingIdentity = computeSourceIdentity(process.cwd());
  const end = endingIdentity.commit;
  if (identity.sourceDigest !== endingIdentity.sourceDigest || head !== end) { console.error('[source-suite] source changed during verification; result cannot validate a single revision'); code = 1; }
  let totals = null;
  if (tap) {
    const finished = once(tap, 'finish'); tap.end(); await finished;
    const text = await readFile(tapPath, 'utf8');
    totals = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key, Number([...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].at(-1)?.[1] ?? NaN)]));
  }
  await checkpoint({ phase: code === 0 ? 'passed' : 'failed', exitCode: code, endedAt: new Date().toISOString(), endingIdentity, durationMs: Date.now() - started, totals });
  console.error(`[source-suite] receipt=${receiptPath}`);
  console.error(`[source-suite] start=${head} end=${end} exit=${code} durationMs=${Date.now() - started}`);
}
process.exitCode = code;
