/** Actual SIGKILL/restart matrix. Controlled PCM/CLI is NOT learned inference. */
import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, chmod, readFile, access, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../helpers/mission-postgres";
import { projects, sourceAssets, processingJobs, stemAssets } from "../../src/db/waveyardSchema";
import { encodeWav16 } from "../../src/lib/waveyard/mixer/synth";
import { LocalStorageProvider } from "../../src/lib/waveyard/storage";
import { ownerIdentity, ownerState } from "../../src/lib/waveyard/separation/recovery";
import { resolveToolPath } from "../../src/lib/waveyard/ffmpeg";
import { writeStubDeepEngine } from "../../src/lib/waveyard/separation/deep-fixtures";

test("native separation real SIGKILL/restart matrix", { timeout: 360000 }, async t => {
  if (process.platform !== "linux") { t.skip("Linux incarnation probe acceptance; other platforms fail closed, not accepted"); return; }
  const pg = await missionPostgres(); const root = await mkdtemp(join(tmpdir(), "arena-separation-crashes-"));
  const storage = new LocalStorageProvider(join(root, "storage")); const children: ChildProcess[] = [];
  const [project] = await pg.database.insert(projects).values({ ownerId: randomUUID(), title: "Controlled crash matrix" }).returning();
  const wav = encodeWav16(Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i * .05) * .2), 44100);
  const sourceKey = `projects/${project.id}/source/${randomUUID()}.wav`;
  const sourcePath = join(root, "source.wav"); await writeFile(sourcePath, wav); await storage.putFile(sourceKey, sourcePath);
  const [source] = await pg.database.insert(sourceAssets).values({ projectId: project.id, originalFilename: "controlled.wav", mimeType: "audio/wav", storageKey: sourceKey, checksumSha256: createHash("sha256").update(wav).digest("hex"), durationSeconds: 1, sampleRate: 44100, channels: 2, codec: "pcm_s16le", fileSizeBytes: wav.length }).returning();
  async function job() {
    const [row] = await pg.database.insert(processingJobs).values({ projectId: project.id, sourceAssetId: source.id, type: "separation", model: "deep_4s", requestedDevice: "cpu", idempotencyKey: randomUUID() }).returning();
    return row;
  }
  function worker(row: typeof processingJobs.$inferSelect, mode: string, phase = "", env: Partial<NodeJS.ProcessEnv> = {}) {
    const messages: Record<string, unknown>[] = [];
    const child = fork(resolve("tests/fixtures/separation-crash-worker.ts"), [], { execArgv: ["--import", resolve("scripts/register-src-loader.mjs")], env: { ...process.env, ...env, DATABASE_URL: pg.url, WAVEYARD_STORAGE_DIR: join(root, "storage"), WAVEYARD_LOCAL_WORKER: "0", CRASH_INPUT: JSON.stringify({ processingJobId: row.id, projectId: row.projectId, sourceAssetId: row.sourceAssetId, model: row.model, requestedDevice: row.requestedDevice }), CRASH_MODE: mode, CRASH_PHASE: phase }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child); let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk; }); child.stdout?.resume();
    child.on("message", message => messages.push(message as Record<string, unknown>));
    const exit = once(child, "exit");
    async function at(target: string) {
      const deadline = Date.now() + 20000;
      while (!messages.some(m => m.phase === target)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`No boundary ${target}: ${JSON.stringify(messages)} ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return { child, messages, at, async kill() { child.kill("SIGKILL"); await exit; }, async done(expected = 0) { const [code] = await exit; assert.equal(code, expected, `${JSON.stringify(messages)} ${stderr}`); return messages; } };
  }
  async function recover(row: typeof processingJobs.$inferSelect) { return worker(row, "recover").done(); }
  async function assertBank(row: typeof processingJobs.$inferSelect, expected: number) {
    const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
    const stems = await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id));
    assert.equal(stems.length, expected);
    for (const stem of stems) { assert.equal(await storage.exists(stem.storageKey), true); assert.equal(createHash("sha256").update(await storage.getBuffer(stem.storageKey, Number(stem.fileSizeBytes))).digest("hex"), stem.checksumSha256); }
    assert.equal(current.status, expected ? "complete" : "failed");
    const execution = JSON.parse(current.metadata).execution;
    assert.equal(execution.cleanupPending, false);
    await assert.rejects(access(execution.workDirectory), { code: "ENOENT" });
    return current;
  }
  try {
    for (const [phase, expected] of [["claimed", 0], ["inference-starting", 0], ["inference-running", 0], ["outputs-written", 0], ["staging", 0], ["object-partial", 0], ["object-written:1", 0], ["object-written:4", 4], ["validated", 4], ["publication-locked", 4], ["committed", 4]] as const) {
      await t.test(phase, async () => {
        const row = await job(); const w = worker(row, "execute", phase); await w.at(phase);
        if (phase === "publication-locked") {
          const waiting = worker(row, "recover");
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(waiting.messages.some(m => m.result), false, "recovery waits for publication row lock");
          await w.kill(); await waiting.done();
        } else {
          const live = await recover(row); assert.ok(live.some(m => m.result === "owner-not-proven-dead"));
          await w.kill();
        }
        await worker(row, "startup").done(); await assertBank(row, expected);
        const before = await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id));
        await Promise.all([recover(row), recover(row)]); await assertBank(row, expected);
        assert.deepEqual(new Set((await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id))).map(s => s.id)), new Set(before.map(s => s.id)));
      });
    }
    await t.test("queued restart has no phantom executor", async () => {
      const row = await job(); const w = worker(row, "execute", "before-claim"); await w.at("before-claim"); await w.kill();
      const m = await worker(row, "startup").done(); assert.ok(m.some(v => v.queued === row.id));
      await worker(row, "execute").done(); await assertBank(row, 4);
    });
    for (const phase of ["cleanup-written", "recovery-committed-before-ack"]) await t.test(`reconciler crash: ${phase}`, async () => {
      const row = await job(); const w = worker(row, "execute", phase === "cleanup-written" ? "object-written:1" : "validated"); await w.at(phase === "cleanup-written" ? "object-written:1" : "validated"); await w.kill();
      const r = worker(row, "recover", phase); await r.at(phase); await r.kill();
      await recover(row); await assertBank(row, phase === "cleanup-written" ? 0 : 4);
    });
    for (const phase of ["native-unregistered", "native-registered", "inference-running"]) await t.test(`real Python ownership pipe: ${phase}`, async () => {
      const stub = await writeStubDeepEngine(join(root, randomUUID()), sourcePath, { hangIgnoringTermination: true, demucsVersion: "4.0.1" }); assert.ok(stub);
      const inserted = await job(); await pg.database.update(processingJobs).set({ model: "deep_6s" }).where(eq(processingJobs.id, inserted.id));
      const row = { ...inserted, model: "deep_6s" }; const w = worker(row, "execute", phase, { ...stub.env, CRASH_NATIVE: "1" }); await w.at(phase); await w.kill();
      const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
      const native = JSON.parse(current.metadata).execution.child;
      if (native) { const deadline = Date.now() + 3000; while (await ownerState(native) === "live" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(await ownerState(native), "dead"); }
      await recover(row); await assertBank(row, 0);
    });
    await t.test("pending cancellation plus executor crash", async () => {
      const row = await job(); const w = worker(row, "execute", "validated"); await w.at("validated");
      await pg.database.update(processingJobs).set({ status: "cancelling" }).where(eq(processingJobs.id, row.id)); await w.kill(); await recover(row);
      const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); assert.equal(current.status, "cancelled"); assert.equal((await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id))).length, 0);
    });
    await t.test("corrupt staged file is retired, not published", async () => {
      const row = await job(), w = worker(row, "execute", "validated"); await w.at("validated"); await w.kill();
      const [j] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); const e = JSON.parse(j.metadata).execution;
      await writeFile(storage.getLocalPath(e.outputs[0].storageKey)!, "partial corrupted output"); await recover(row); await assertBank(row, 0);
    });
    for (const unavailable of ["read", "cleanup"]) await t.test(`storage ${unavailable} failure retains journal for retry`, async () => {
      const phase = unavailable === "read" ? "validated" : "object-written:1";
      const row = await job(), w = worker(row, "execute", phase); await w.at(phase); await w.kill();
      const directory = join(root, "storage", "projects", project.id, "stem");
      await chmod(directory, unavailable === "read" ? 0 : 0o555);
      try { await worker(row, "recover").done(1); }
      finally { await chmod(directory, 0o755); }
      await recover(row); await assertBank(row, unavailable === "read" ? 4 : 0);
    });
    await t.test("database dies during recovery; restart converges", async () => {
      const row = await job(), w = worker(row, "execute", "validated"); await w.at("validated"); await w.kill();
      const r = worker(row, "recover", "recovery-publication"); await r.at("recovery-publication");
      await pg.stop(); await r.kill(); await pg.start(); await recover(row); await assertBank(row, 4);
    });
    await t.test("retry races recovery, then creates one fresh attempt retaining history", async () => {
      const row = await job(), w = worker(row, "execute", "object-written:1"); await w.at("object-written:1"); await w.kill();
      const r = worker(row, "recover", "reconciling"); await r.at("reconciling");
      const { retrySeparationJob } = await import("../../src/lib/waveyard/separation/retry");
      assert.equal((await retrySeparationJob(pg.database, row.id)).queued, false);
      await r.kill(); await recover(row);
      const [old] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
      const { restartCancelledSeparation } = await import("../../src/lib/waveyard/separation/cancel");
      const outcomes = await Promise.all([restartCancelledSeparation(pg.database, old, { enqueue: async () => {} }), restartCancelledSeparation(pg.database, old, { enqueue: async () => {} })]);
      const result = outcomes.find(o => o.outcome === "queued"); assert.ok(result && result.outcome === "queued"); assert.notEqual(result.job.id, old.id);
      assert.equal(outcomes.filter(o => o.outcome === "queued").length, 1);
      await worker(result.job, "execute").done(); await assertBank(result.job, 4);
      const [preserved] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, old.id)); assert.deepEqual(preserved, old);
    });
    await t.test("outdated completion state is reconciled without replacing committed assets", async () => {
      const row = await job(), w = worker(row, "execute", "committed"); await w.at("committed"); await w.kill();
      await pg.database.update(processingJobs).set({ status: "finalizing" }).where(eq(processingJobs.id, row.id));
      await recover(row); await assertBank(row, 4);
    });
    await t.test("lost recovery COMMIT acknowledgement preserves the published bank", async () => {
      const row = await job(), w = worker(row, "execute", "validated"); await w.at("validated"); await w.kill();
      await worker(row, "recover", "", { CRASH_LOST_ACK: "1" }).done(1);
      await assertBank(row, 4); await recover(row); await assertBank(row, 4);
    });
    for (const phase of ["claimed", "inference-starting", "inference-running", "object-partial", "validated", "committed"]) await t.test(`cancel and SIGKILL at ${phase}`, async () => {
      const row = await job(), w = worker(row, "execute", phase); await w.at(phase);
      const { requestSeparationCancellation } = await import("../../src/lib/waveyard/separation/cancel");
      const cancelled = await requestSeparationCancellation(pg.database, row.id);
      assert.equal(cancelled?.status, phase === "committed" ? "complete" : "cancelling");
      await w.kill(); await worker(row, "startup").done();
      const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id));
      assert.equal(current.status, phase === "committed" ? "complete" : "cancelled");
      const stems = await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id)); assert.equal(stems.length, phase === "committed" ? 4 : 0);
      for (const stem of stems) assert.equal(await storage.exists(stem.storageKey), true);
    });
    await t.test("queued cancellation cannot later claim or publish", async () => {
      const row = await job(); const { requestSeparationCancellation } = await import("../../src/lib/waveyard/separation/cancel");
      await requestSeparationCancellation(pg.database, row.id); await worker(row, "execute").done();
      const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); assert.equal(current.status, "cancelled"); assert.equal(JSON.parse(current.metadata).execution, undefined);
    });
    await t.test("cancellation waiting at uncommitted publication wins after executor crash", async () => {
      const row = await job(), w = worker(row, "execute", "publication-locked"); await w.at("publication-locked");
      const { requestSeparationCancellation } = await import("../../src/lib/waveyard/separation/cancel"); const cancelling = requestSeparationCancellation(pg.database, row.id);
      assert.equal(await Promise.race([cancelling.then(() => "finished"), new Promise(resolve => setTimeout(() => resolve("locked"), 50))]), "locked");
      await w.kill(); assert.equal((await cancelling)?.status, "cancelling"); await recover(row);
      const [current] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); assert.equal(current.status, "cancelled"); assert.equal((await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id))).length, 0);
    });
    await t.test("committed-bank temporary cleanup failure is retried on fresh startup", async () => {
      const row = await job(), w = worker(row, "execute", "committed"); await w.at("committed"); await w.kill();
      const [before] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); const directory = JSON.parse(before.metadata).execution.workDirectory;
      await chmod(directory, 0o500);
      try {
        const messages = await worker(row, "startup").done(); assert.match(JSON.stringify(messages), /recovery-pending/);
        const [pending] = await pg.database.select().from(processingJobs).where(eq(processingJobs.id, row.id)); assert.equal(pending.status, "complete"); assert.equal(JSON.parse(pending.metadata).execution.cleanupPending, true);
        const stems = await pg.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, row.id)); assert.equal(stems.length, 4); for (const stem of stems) assert.equal(await storage.exists(stem.storageKey), true);
      } finally { await chmod(directory, 0o700); }
      await worker(row, "startup").done(); await assertBank(row, 4);
    });
    for (const phase of ["decoder-unregistered", "decoder-registered", "decoder-running", "decoder-complete"]) await t.test(`actual FFmpeg lifetime: ${phase}`, async () => {
      const ffmpeg = await resolveToolPath("ffmpeg"); assert.ok(ffmpeg, "Installed real FFmpeg is required, not a fake decoder");
      const slow = join(root, `ffmpeg-${randomUUID()}`); await writeFile(slow, `#!/bin/sh\nexec ${JSON.stringify(ffmpeg.path)} -re "$@"\n`, { mode: 0o755 });
      const bytes = encodeWav16(new Float32Array(48000 * 2 * 10), 48000), path = join(root, `${randomUUID()}.wav`), key = `projects/${project.id}/source/${randomUUID()}.wav`;
      await writeFile(path, bytes); await storage.putFile(key, path);
      const [input] = await pg.database.insert(sourceAssets).values({ projectId: project.id, originalFilename: "rate-conversion.wav", mimeType: "audio/wav", storageKey: key, checksumSha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: 10, sampleRate: 48000, channels: 2, codec: "pcm_s16le", fileSizeBytes: bytes.length }).returning();
      const old = await job(); await pg.database.update(processingJobs).set({ sourceAssetId: input.id }).where(eq(processingJobs.id, old.id)); const row = { ...old, sourceAssetId: input.id };
      const w = worker(row, "execute", phase.startsWith("decoder-") && ["decoder-running", "decoder-complete"].includes(phase) ? "" : phase, { CRASH_DECODER_BIN: slow });
      if (phase === "decoder-complete") { await w.done(); await assertBank(row, 4); return; }
      await w.at(phase === "decoder-running" ? "decoder-registered" : phase);
      const pid = w.messages.find(m => m.nativePid)?.nativePid as number; assert.ok(pid); const guardian = await ownerIdentity(pid); let native;
      if (phase === "decoder-running") {
        const deadline = Date.now() + 3000; let children: string[] = [];
        while (!children.length && Date.now() < deadline) { children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean); if (!children.length) await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.equal(children.length, 1);
        // /proc exposes the child during fork/exec, when cmdline may be empty
        // or still name the launcher. Observe the real executable, not just a
        // process that will eventually become FFmpeg. No skipped assertions.
        const executable = await realpath(ffmpeg.path);
        while (Date.now() < deadline) {
          try {
            if (await readlink(`/proc/${children[0]}/exe`) === executable && (await readFile(`/proc/${children[0]}/cmdline`, "utf8")).length > 0) { native = await ownerIdentity(Number(children[0])); break; }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(native, "Actual FFmpeg executable must be observed before killing its executor"); assert.equal(await ownerState(native), "live");
      }
      await w.kill();
      const deadline = Date.now() + 5000; while (await ownerState(guardian) === "live" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(await ownerState(guardian), "dead"); if (native) assert.equal(await ownerState(native), "dead");
      await worker(row, "startup").done(); await assertBank(row, 0);
    });
    await t.test("successful but corrupt object write is refused before normal publication", async () => {
      const row = await job(); await worker(row, "execute", "", { CRASH_CORRUPT_WRITE: "1" }).done(1);
      const current = await assertBank(row, 0); assert.match(current.errorMessage!, /checksum\/frame validation/);
      const execution = JSON.parse(current.metadata).execution; for (const output of execution.outputs) assert.equal(await storage.exists(output.storageKey), false);
    });
    await t.test("PID incarnation mismatch is dead, unknown scope is not reclaimed", async () => {
      const identity = await ownerIdentity(); assert.ok(identity); assert.equal(await ownerState(identity), "live"); assert.equal(await ownerState({ ...identity, start: identity.start + "0" }), "dead"); assert.equal(await ownerState({ ...identity, boot: "different" }), "unknown");
    });
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await pg.close(); await rm(root, { recursive: true, force: true }); }
});
