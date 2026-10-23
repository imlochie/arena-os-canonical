/** Real database, storage and pipeline; controlled inference, NOT model acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { processingJobs, stemAssets } from "@/db/waveyardSchema";
import { requestSeparationCancellation, restartCancelledSeparation } from "@/lib/waveyard/separation/cancel";
import { getStorage } from "@/lib/waveyard/storage";
import { handleSeparationJob } from "./separation";
import { fixture, payloadOf, identityEngine } from "./separation-fixtures";

test("queued cancel is terminal, never opens inference; explicit restart preserves history and identity", async () => {
  const f = await fixture();
  try {
    assert.equal((await requestSeparationCancellation(f.database, f.job.id))?.status, "cancelled");
    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: async () => { throw new Error("must not open"); } });
    const [cancelled] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    let payload: Record<string, unknown> | undefined;
    const result = await restartCancelledSeparation(f.database, cancelled, { enqueue: async value => { payload = value; } });
    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") return;
    assert.notEqual(result.job.id, f.job.id);
    assert.equal(result.job.sourceAssetId, f.job.sourceAssetId);
    assert.equal(result.job.idempotencyKey, f.job.idempotencyKey);
    const refused = await restartCancelledSeparation(f.database, cancelled, { enqueue: async () => { throw new Error("duplicate"); } });
    assert.equal(refused.outcome, "active");
    await handleSeparationJob(payload!, { db: f.database, openEngine: identityEngine() });
    const rows = await f.database.select().from(processingJobs);
    assert.equal(rows.find(row => row.id === f.job.id)?.status, "cancelled");
    assert.equal(rows.find(row => row.id === result.job.id)?.status, "complete");
  } finally { await f.close(); }
});

test("cancel during an in-flight MDX chunk retains active target until release; no output is published", async () => {
  const f = await fixture(); let released = false;
  try {
    await assert.rejects(handleSeparationJob(payloadOf(f), { db: f.database, openEngine: async () => ({ resolvedDevice: "cpu", release: async () => { released = true; }, infer: async data => {
      const current = await requestSeparationCancellation(f.database, f.job.id);
      assert.equal(current?.status, "cancelling");
      assert.equal(current?.completedAt, null);
      return data;
    } }) }), { name: "AbortError" });
    assert.ok(released);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "cancelled");
    assert.equal(row.errorCode, "cancelled");
    assert.equal((await f.database.select().from(stemAssets)).length, 0);
  } finally { await f.close(); }
});

test("cancellation after upload fences atomic publication and removes staged objects; completed banks resist late cancel", async () => {
  const f = await fixture();
  const storage = getStorage(); const original = storage.putFile; const deleted = storage.delete; const uploaded: string[] = []; const removed: string[] = [];
  try {
    storage.putFile = async (...args) => { await original.apply(storage, args); uploaded.push(args[0]); if (uploaded.length === 2) await requestSeparationCancellation(f.database, f.job.id); };
    storage.delete = async key => { removed.push(key); await deleted.call(storage, key); };
    await assert.rejects(handleSeparationJob(payloadOf(f), { db: f.database, openEngine: identityEngine() }), { name: "AbortError" });
    assert.equal(uploaded.length, 2);
    assert.deepEqual(removed, uploaded);
    assert.equal((await f.database.select().from(stemAssets)).length, 0);
    storage.putFile = original; storage.delete = deleted;
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    const restarted = await restartCancelledSeparation(f.database, row, { enqueue: async () => {} });
    assert.equal(restarted.outcome, "queued"); if (restarted.outcome !== "queued") return;
    await handleSeparationJob({ ...payloadOf(f), processingJobId: restarted.job.id }, { db: f.database, openEngine: identityEngine() });
    assert.equal((await requestSeparationCancellation(f.database, restarted.job.id))?.status, "complete");
    assert.equal((await f.database.select().from(stemAssets)).length, 2);
  } finally { storage.putFile = original; storage.delete = deleted; await f.close(); }
});

test("tampered stored source fails before opening a model", async () => {
  const f = await fixture(); let opened = false;
  try {
    await writeFile(getStorage().getLocalPath(f.source.storageKey)!, Buffer.from("changed source"));
    await assert.rejects(handleSeparationJob(payloadOf(f), { db: f.database, openEngine: async spec => { opened = true; return identityEngine()(spec); } }), /verified source checksum/);
    assert.equal(opened, false);
    assert.equal((await f.database.select().from(stemAssets)).length, 0);
  } finally { await f.close(); }
});

/** A controlled six-WAV bridge keeps these storage-failure tests free of FFT
 * cost; it is explicitly not a trained model. */
const controlledDeep: NonNullable<import("./separation").SeparationHandlerDeps["runDeep"]> = async request => ({
  engine: "demucs", model: "deep_6s", modelName: "CONTROLLED-NOT-LEARNED", modelVersion: "CONTROLLED-NOT-LEARNED", checkpointPath: "NO-WEIGHTS", resolvedDevice: "cpu",
  stems: ["drums", "bass", "other", "vocals", "guitar", "piano"].map(stemType => ({ stemType: stemType as import("../separation/modes").DeepStemType, path: request.inputPath, bytes: 44 + 44100 * 4 })),
});

test("cancel cleanup failure retains orphan keys and warning on the cancelled attempt", async () => {
  const f = await fixture({ model: "deep_6s" }); const storage = getStorage(); const put = storage.putFile, del = storage.delete; const keys: string[] = [];
  try {
    storage.putFile = async (...args) => { await put.apply(storage, args); keys.push(args[0]); if (keys.length === 6) await requestSeparationCancellation(f.database, f.job.id); };
    storage.delete = async key => { if (key === keys[0]) throw new Error("controlled cleanup outage"); await del.call(storage, key); };
    await assert.rejects(handleSeparationJob(payloadOf(f), { db: f.database, runDeep: controlledDeep }), { name: "AbortError" });
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "cancelled"); assert.match(row.errorMessage!, /could not be removed/);
    assert.deepEqual(JSON.parse(row.metadata!).cleanupFailedKeys, [keys[0]]);
    assert.equal((await f.database.select().from(stemAssets)).length, 0);
  } finally { storage.putFile = put; storage.delete = del; await f.close(); }
});

test("derived-waveform reporting outage after commit must never delete a published bank", async () => {
  const f = await fixture({ model: "deep_6s" });
  const { waveformJobs } = await import("@/db/waveyardSchema");
  const db = new Proxy(f.database, { get(target, key) {
    if (key === "update") return (table: unknown) => { if (table === waveformJobs) throw new Error("controlled waveform state outage"); return target.update(table as typeof processingJobs); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    await assert.rejects(handleSeparationJob(payloadOf(f), { db, runDeep: controlledDeep }), /controlled waveform state outage/);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)); assert.equal(row.status, "complete");
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id)); assert.equal(stems.length, 6);
    for (const stem of stems) assert.equal(await getStorage().exists(stem.storageKey), true, "committed audio survives ancillary failure");
  } finally { await f.close(); }
});


test("readable but truncated deep stems cannot publish a misaligned bank", async () => {
  const f = await fixture({ model: "deep_6s" });
  try {
    const { encodeWav16 } = await import("@/lib/waveyard/mixer/synth");
    const path = `${f.sourcePath}.truncated.wav`;
    await writeFile(path, encodeWav16(new Float32Array(200), 44100));
    await assert.rejects(handleSeparationJob(payloadOf(f), { db: f.database, runDeep: async request => {
      const result = await controlledDeep(request); return { ...result, stems: result.stems.map(stem => ({ ...stem, path })) };
    } }), /expected exactly 44100 source frames/);
    assert.equal((await f.database.select().from(stemAssets)).length, 0);
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id)); assert.equal(row.status, "failed");
  } finally { await f.close(); }
});
