// Read-only evidence publishing for constrained environments; never awards a
// pass or replaces the acceptance command's exit code. Full receipts stay in artifacts.
import { readFile } from 'node:fs/promises';
const file = process.argv[2];
try {
  const r = JSON.parse(await readFile(file, 'utf8'));
  const receipt = { file, scope: r.scope, testedCommit: r.testedCommit, combinedTree: r.combinedTree, ownerSnapshot: r.ownerSnapshot,
    originalSha256: r.originalSha256, rights: r.rights, outputs: r.outputs, player: r.player, sessionId: r.sessionId,
    sessionRms: r.sessionRms, reopenedSessionRms: r.reopenedSessionRms, reopenedSessionIdentityVerified: r.reopenedSessionIdentityVerified,
    handoff: r.handoff, versionId: r.versionId, exportJobId: r.exportJobId, zipSha256: r.zipSha256, export: r.export,
    originalAndPublishedOutputsUnchanged: r.originalAndPublishedOutputsUnchanged, routeErrors: r.routeErrors, browserErrors: r.browserErrors, runtime: r.runtime };
  const chunks = JSON.stringify(receipt).match(/[\s\S]{1,2800}/g) ?? [];
  if (chunks.length > 9) throw new Error('Receipt exceeds notice budget; inspect retained full artifact.');
  const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  for (const [i, text] of chunks.entries()) console.log(`::notice title=Converted journey ${i + 1}/${chunks.length}::${escape(text)}`);
} catch (error) {
  console.log(`::warning::Connected journey receipt unavailable: ${String(error).replaceAll('\n', ' ')}. Not independently accepted by this publisher.`);
}
