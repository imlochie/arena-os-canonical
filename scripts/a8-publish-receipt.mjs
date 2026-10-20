// Render existing evidence into GitHub's check annotations/summary. This does
// not execute, repair, or decide acceptance; the original test exit stays final.
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.env.ARENA_A8_EVIDENCE_DIR || '.data/acceptance/a8');
let receipt;
try { receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')); }
catch { receipt = { error: 'No inference receipt was produced: acceptance did not reach its test body.', gates: 'NOT ACCEPTED' }; }
const tap = await readFile(path.join(directory, 'run.tap'), 'utf8').catch(() => 'No TAP file was produced.');
const failure = tap.includes('not ok') ? tap.slice(tap.indexOf('not ok')).slice(0, 18000) : tap.slice(-2500);
const compact = { commit: process.env.GITHUB_SHA, scope: receipt.scope, source: receipt.source, gates: receipt.gates, error: receipt.error, engines: receipt.engines?.map(engine => ({ model: engine.model, checkpoint: engine.checkpoint, preparation: { state: engine.preparation?.status?.state, environment: engine.preparation?.status?.environment, error: engine.preparation?.status?.error, log: engine.preparation?.status?.log?.slice(-18) }, job: engine.job, stems: engine.stems, export: engine.export })) };
const text = JSON.stringify(compact, null, 2).slice(0, 28000);
const summary = `# A8 execution receipt\n\nThe test exit code remains authoritative. Open/failed gates are not accepted. Audio/trace artifacts include RIGHTS.txt; weights are not uploaded.\n\n\`\`\`json\n${text}\n\`\`\`\n\n## TAP result / failure\n\n\`\`\`text\n${failure}\n\`\`\`\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
// Official Checks annotations remain retrievable through api.github.com even
// when this environment cannot reach the separate signed log/artifact host.
const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
console.log(`::notice title=A8 execution receipt::${escape(text + '\nTAP:\n' + failure)}`);
