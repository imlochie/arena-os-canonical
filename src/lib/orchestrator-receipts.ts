/** Immutable execution receipts in Arena's existing private object provider.
 * SQL claims precede dispatch; receipt publication precedes SQL completion.
 * Missing receipts never imply that an external operation is safe to replay.
 * Unbound objects are retained for reconciliation, never eagerly deleted.
 */
import { createHash } from "node:crypto";
import { LOCAL_OWNER_ID } from "@/db/schema";
import { isUuid } from "@/lib/api/ids";
import { getStorage } from "@/lib/waveyard/storage";
import type { Relay, RelayToolStep } from "@/lib/orchestrator";
export const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
export type ReceiptReference = { sha256: string; bytes: number };
export type RetainedReceipt = { version: 1; ownerId: string; collaborationId: string; relayId: string; requestSha256: string; text: string; via: string; steps: RelayToolStep[]; runtime?: unknown; createdAt: string };
export class ReceiptIntegrityError extends Error { readonly status = 422; }
function sha(text: string) { return createHash("sha256").update(text, "utf8").digest("hex"); }
function key(id: string) {
  if (!isUuid(id)) throw new ReceiptIntegrityError("Invalid retained-result identity.");
  return `owners/${LOCAL_OWNER_ID}/orchestrator-receipts/${id}.json`;
}
function requestDigest(relay: Relay) {
  return sha(JSON.stringify({ collaborationId: relay.collaborationId, seq: relay.seq, source: relay.sourceKey, target: relay.targetKey, purpose: relay.purpose, request: relay.request, contextRefs: relay.contextRefs, classification: relay.classification, responseContract: relay.responseContract, toolUse: relay.toolUse }));
}
export async function retainRelayResult(relay: Relay, result: { text: string; via: string; runtime?: unknown }, steps: RelayToolStep[]) {
  // GenerateResult.text is already retained as text; don't duplicate it inside
  // execution metadata or let it turn a bounded receipt into two huge copies.
  const runtime = result.runtime && typeof result.runtime === "object" ? Object.fromEntries(Object.entries(result.runtime).filter(([name]) => name !== "text")) : result.runtime;
  const receipt: RetainedReceipt = { version: 1, ownerId: LOCAL_OWNER_ID, collaborationId: relay.collaborationId, relayId: relay.id, requestSha256: requestDigest(relay), text: result.text, via: result.via, steps, runtime, createdAt: new Date().toISOString() };
  const payload = JSON.stringify(receipt);
  const bytes = Buffer.from(JSON.stringify({ sha256: sha(payload), payload }), "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error("Complete result exceeds the32MiB receipt limit; it was not marked completed. Review the uncertain dispatch; it will not be automatically replayed.");
  await getStorage().putImmutableBuffer(key(relay.id), bytes);
  return { receipt, reference: { sha256: sha(payload), bytes: Buffer.byteLength(result.text, "utf8") } };
}
export async function readRetainedRelayResult(relay: Relay) {
  let bytes;
  try { bytes = await getStorage().getBuffer(key(relay.id), MAX_RECEIPT_BYTES); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (typeof envelope.payload !== "string" || sha(envelope.payload) !== envelope.sha256) throw new Error();
    const receipt = JSON.parse(envelope.payload) as RetainedReceipt;
    if (receipt.version !== 1 || receipt.ownerId !== LOCAL_OWNER_ID || receipt.collaborationId !== relay.collaborationId || receipt.relayId !== relay.id || receipt.requestSha256 !== requestDigest(relay) || typeof receipt.text !== "string" || typeof receipt.via !== "string" || !Array.isArray(receipt.steps)) throw new Error();
    const reference = { sha256: envelope.sha256 as string, bytes: Buffer.byteLength(receipt.text, "utf8") };
    if (relay.resultReceipt && (relay.resultReceipt.sha256 !== reference.sha256 || relay.resultReceipt.bytes !== reference.bytes)) throw new Error();
    return { receipt, reference };
  } catch { throw new ReceiptIntegrityError("Retained dispatch result is corrupt or not bound to this relay. No completion or replay was performed."); }
}
