import { readStudioExportBundle } from "../../scripts/lib/studio-export-bundle.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  writeFile,
  rm,
  readFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import BullMQ from "bullmq";
import { missionPostgres } from "../helpers/mission-postgres.ts";
test(
  "real Redis/BullMQ expired export lease cannot let a stale worker revoke a verified FX publication; completed queue records recover explicitly",
  { timeout: 120000 },
  async () => {
    const cwd = process.cwd();
    const root = await mkdtemp(path.join(tmpdir(), "arena-fx-lease-"));
    const toolBin = path.join(root, "resolved-tools");
    await mkdir(toolBin);
    const { requireTool } = await import("../../src/lib/waveyard/ffmpeg.ts");
    for (const name of ["ffmpeg", "ffprobe"]) {
      const tool = await requireTool(name);
      await symlink(tool.path, path.join(toolBin, name));
    }
    let f, redis, queue, events, database;
    const children = [];
    async function freePort() {
      const server = createServer();
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      await new Promise((r) => server.close(r));
      return port;
    }
    function spawnWorker(hold) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          path.join(cwd, "waveyard-worker/node_modules/tsx/dist/loader.mjs"),
          path.join(
            cwd,
            "waveyard-worker/apps/worker/test-fixtures/export-lease.mts",
          ),
        ],
        {
          cwd,
          env: {
            ...process.env,
            PATH: `${toolBin}${path.delimiter}${process.env.PATH}`,
            TSX_TSCONFIG_PATH: path.join(cwd, "waveyard-worker/tsconfig.json"),
            HOLD_STAGE: hold ?? "",
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        },
      );
      children.push(child);
      const seen = [],
        bus = new EventEmitter();
      let buffer = "",
        stderr = "";
      child.stderr.on("data", (b) => (stderr += b));
      child.stdout.on("data", (b) => {
        buffer += b;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("EVENT ")) continue;
          const event = JSON.parse(line.slice(6));
          seen.push(event);
          bus.emit("event", event);
        }
      });
      return {
        child,
        wait(predicate) {
          const match = seen.find(predicate);
          if (match) return Promise.resolve(match);
          const failure = seen.find((event) => event.kind === "handler-error");
          if (failure)
            return Promise.reject(
              new Error("Production export handler failed: " + failure.error),
            );
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              bus.off("event", on);
              reject(new Error("Worker deadline: " + stderr));
            }, 20000);
            function on(event) {
              if (predicate(event) || event.kind === "handler-error") {
                clearTimeout(timer);
                bus.off("event", on);
                if (predicate(event)) resolve(event);
                else
                  reject(
                    new Error(
                      "Production export handler failed: " + event.error,
                    ),
                  );
              }
            }
            bus.on("event", on);
          });
        },
      };
    }
    async function api(module, method, body, id) {
      const route = await import(
        path.join(cwd, "src/app/api", module, "route.ts")
      );
      const response = await route[method](
        new Request("http://localhost/api/test", {
          method,
          headers: { host: "localhost", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { params: Promise.resolve({ id }) },
      );
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    try {
      let port,
        redisDb = 0;
      const existingRedis = process.env.ARENA_FX_REDIS_URL;
      if (existingRedis) {
        const url = new URL(existingRedis);
        port = Number(url.port || 6379);
        redisDb = Number(url.pathname.slice(1) || 0);
      } else {
        port = await freePort();
        redis = spawn(
          process.env.ARENA_REDIS_SERVER || "redis-server",
          [
            "--port",
            String(port),
            "--bind",
            "127.0.0.1",
            "--save",
            "",
            "--appendonly",
            "no",
          ],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        await new Promise((resolve, reject) => {
          let out = "";
          const timer = setTimeout(
            () => reject(new Error("Redis readiness deadline")),
            10000,
          );
          redis.stdout.on("data", (b) => {
            out += b;
            if (out.includes("Ready to accept connections")) {
              clearTimeout(timer);
              resolve();
            }
          });
          redis.once("error", reject);
        });
      }
      f = await missionPostgres();
      process.env.DATABASE_URL = f.url;
      process.env.WAVEYARD_STORAGE_DIR = path.join(root, "storage");
      process.env.LOCAL_STORAGE_PATH = process.env.WAVEYARD_STORAGE_DIR;
      process.env.REDIS_URL = `redis://127.0.0.1:${port}/${redisDb}`;
      process.env.WAVEYARD_LOCAL_WORKER = "0";
      database = await import(path.join(cwd, "src/db/index.ts"));
      const schema = await import(path.join(cwd, "src/db/waveyardSchema.ts"));
      const { eq } = await import(
        path.join(cwd, "node_modules/drizzle-orm/index.js")
      );
      const synth = await import(
        path.join(cwd, "src/lib/waveyard/mixer/synth.ts")
      );
      const service = await import(
        path.join(cwd, "src/lib/waveyard/library/service.ts")
      );
      const input = new Float32Array(44100 * 3 * 2);
      for (let frame = 0; frame < input.length / 2; frame++)
        input[frame * 2] = input[frame * 2 + 1] =
          0.2 * Math.sin((2 * Math.PI * 440 * frame) / 44100);
      const filename = path.join(root, "source.wav");
      await writeFile(filename, synth.encodeWav16(input, 44100));
      const { track } = await service.addTrackFromAudioFile({
        ownerId: "00000000-0000-4000-8000-000000000001",
        filePath: filename,
        filename: "real synthetic PCM.wav",
        mimeType: "audio/wav",
      });
      const [row] = await database.db
        .select()
        .from(schema.tracks)
        .where(eq(schema.tracks.id, track.id));
      await api("stems/passthrough", "POST", {
        sourceAssetId: row.sourceAssetId,
      });
      const { remix } = await api(
        "waveyard/projects/[id]/remixes",
        "POST",
        { name: "Real queue lease lifecycle" },
        row.projectId,
      );
      const state = await api("remixes/[id]", "GET", null, remix.id);
      const { makeInsert } = await import(
        path.join(cwd, "src/lib/waveyard/mixer/inserts.ts")
      );
      const t = state.tracks[0];
      const duplicate = { ...t.clips[0] };
      delete duplicate.id;
      await api(
        "remixes/[id]",
        "PUT",
        {
          ...state.remix,
          tracks: [
            {
              ...t,
              phaseInverted: true,
              inserts: [
                makeInsert("saturator", { drive: 3 }),
                makeInsert("delay", { delayMs: 250, feedback: 0.5, mix: 0.5 }),
              ],
              clips: [...t.clips, duplicate],
            },
          ],
          masterInserts: [
            makeInsert("gain", { gainDb: -6 }),
            makeInsert("reverb", { decaySeconds: 0.3 }),
          ],
        },
        remix.id,
      );
      const { version } = await api(
        "remixes/[id]/versions",
        "POST",
        { name: "Immutable lease source" },
        remix.id,
      );
      const [job] = await database.db
        .insert(schema.exportJobs)
        .values({
          projectId: row.projectId,
          remixSessionId: remix.id,
          remixVersionId: version.id,
          requestedById: "00000000-0000-4000-8000-000000000001",
          idempotencyKey: randomUUID(),
          status: "queued",
          stage: "queued",
          format: "wav",
          sampleRate: 44100,
          channels: 2,
        })
        .returning();
      const connection = { host: "127.0.0.1", port, db: redisDb };
      queue = new BullMQ.Queue("waveyard-export", { connection });
      events = new BullMQ.QueueEvents("waveyard-export", { connection });
      await events.waitUntilReady();
      const first = spawnWorker("validating");
      await first.wait((e) => e.kind === "ready");
      const queued = await queue.add(
        "export",
        {
          exportJobId: job.id,
          projectId: row.projectId,
          remixSessionId: remix.id,
          remixVersionId: version.id,
          format: "wav",
        },
        { jobId: job.id },
      );
      await first.wait((e) => e.kind === "stage" && e.stage === "validating");
      const [pinned] = await database.db
        .select()
        .from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, version.id));
      const snapshotSha256 = createHash("sha256")
        .update(JSON.stringify(pinned.snapshot))
        .digest("hex");
      await api(
        "remixes/[id]",
        "PUT",
        {
          ...state.remix,
          masterVolume: 0.1,
          tracks: [{ ...t, phaseInverted: false, inserts: [], volume: 0.1 }],
        },
        remix.id,
      );
      const [afterEdit] = await database.db
        .select()
        .from(schema.remixVersions)
        .where(eq(schema.remixVersions.id, version.id));
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(afterEdit.snapshot))
          .digest("hex"),
        snapshotSha256,
      );
      process.kill(-first.child.pid, "SIGSTOP");
      const second = spawnWorker();
      await second.wait((e) => e.kind === "ready");
      await queued.waitUntilFinished(events, 20000);
      const [winner] = await database.db
        .select()
        .from(schema.exportJobs)
        .where(eq(schema.exportJobs.id, job.id));
      assert.equal(winner.status, "complete");
      process.kill(-first.child.pid, "SIGCONT");
      first.child.stdin.write("continue\n");
      const late = await first.wait(
        (e) => e.kind === "handler-error" || e.kind === "returned",
      );
      const [finished] = await database.db
        .select()
        .from(schema.exportJobs)
        .where(eq(schema.exportJobs.id, job.id));
      const assets = await database.db
        .select()
        .from(schema.exportAssets)
        .where(eq(schema.exportAssets.exportJobId, job.id));
      console.log(
        JSON.stringify({
          runtime:
            "real native PostgreSQL + Redis + BullMQ Worker production export handler",
          redisVersion: spawnSync("redis-server", ["--version"], { encoding: "utf8" }).stdout.trim(),
          queueState: await queued.getState(),
          beforeLateWorker: winner.status,
          afterLateWorker: finished.status,
          assets: assets.length,
          late: { kind: late.kind },
          checksumSha256: assets[0]?.checksumSha256,
          expectedStatus: "complete",
        }),
      );
      assert.equal(
        finished.status,
        "complete",
        "A stale worker must not overwrite a valid completed publication with failed",
      );
      assert.equal(assets.length, 1);
      const output = path.join(
        process.env.WAVEYARD_STORAGE_DIR,
        assets[0].storageKey,
      );
      const original = await readFile(output);
      assert.equal(
        createHash("sha256").update(original).digest("hex"),
        assets[0].checksumSha256,
      );
      const [referenceJob] = await database.db
        .insert(schema.exportJobs)
        .values({
          projectId: row.projectId,
          remixSessionId: remix.id,
          remixVersionId: version.id,
          requestedById: "00000000-0000-4000-8000-000000000001",
          idempotencyKey: randomUUID(),
          status: "queued",
          stage: "queued",
          format: "wav",
          sampleRate: 44100,
          channels: 2,
        })
        .returning();
      await (
        await import(path.join(cwd, "src/lib/waveyard/worker-local/export.ts"))
      ).handleExportJob({
        exportJobId: referenceJob.id,
        projectId: row.projectId,
        remixSessionId: remix.id,
        remixVersionId: version.id,
        format: "wav",
      });
      const [reference] = await database.db
        .select()
        .from(schema.exportAssets)
        .where(eq(schema.exportAssets.exportJobId, referenceJob.id));
      const expected = synth.decodeWav16(
        new Uint8Array(
          await readFile(
            path.join(process.env.WAVEYARD_STORAGE_DIR, reference.storageKey),
          ),
        ),
      );
      const actual = synth.decodeWav16(new Uint8Array(original));
      assert.equal(actual.samples.length, expected.samples.length);
      let maxError = 0;
      for (let i = 0; i < actual.samples.length; i++)
        maxError = Math.max(
          maxError,
          Math.abs(actual.samples[i] - expected.samples[i]),
        );
      assert.ok(
        maxError < 0.00015,
        `local deterministic reference PCM error ${maxError}`,
      );
      console.log(
        JSON.stringify({
          kind: "real-queue-FX-reference",
          inputSha256: createHash("sha256")
            .update(await readFile(filename))
            .digest("hex"),
          snapshotSha256,
          liveWorkspaceChangedAfterClaim: true,
          maxError,
          frames: actual.samples.length / 2,
          checksumSha256: assets[0].checksumSha256,
          versionId: version.id,
        }),
      );

      process.kill(-first.child.pid, "SIGKILL");
      for (const stage of [
        "resolving-remix",
        "rendering",
        "ffmpeg-active",
        "validating",
        "publishing",
        "committing",
        "complete",
      ]) {
        process.kill(-second.child.pid, "SIGSTOP");
        const [interrupted] = await database.db
          .insert(schema.exportJobs)
          .values({
            projectId: row.projectId,
            remixSessionId: remix.id,
            remixVersionId: version.id,
            requestedById: "00000000-0000-4000-8000-000000000001",
            idempotencyKey: randomUUID(),
            status: "queued",
            stage: "queued",
            format: "wav",
            sampleRate: 44100,
            channels: 2,
          })
          .returning();
        const fault = spawnWorker(stage);
        await fault.wait((e) => e.kind === "ready");
        const record = await queue.add(
          "export",
          {
            exportJobId: interrupted.id,
            projectId: row.projectId,
            remixSessionId: remix.id,
            remixVersionId: version.id,
            format: "wav",
          },
          { jobId: interrupted.id },
        );
        await fault.wait((e) => e.kind === "stage" && e.stage === stage);
        process.kill(-fault.child.pid, "SIGKILL");
        const beforeAssets = await database.db
          .select()
          .from(schema.exportAssets)
          .where(eq(schema.exportAssets.exportJobId, interrupted.id));
        assert.equal(beforeAssets.length, stage === "complete" ? 1 : 0);
        const [beforeState] = await database.db
          .select()
          .from(schema.exportJobs)
          .where(eq(schema.exportJobs.id, interrupted.id));
        assert.equal(beforeState.status === "complete", stage === "complete");
        process.kill(-second.child.pid, "SIGCONT");
        await record.waitUntilFinished(events, 20000);
        const [recovered] = await database.db
          .select()
          .from(schema.exportJobs)
          .where(eq(schema.exportJobs.id, interrupted.id));
        const published = await database.db
          .select()
          .from(schema.exportAssets)
          .where(eq(schema.exportAssets.exportJobId, interrupted.id));
        assert.equal(recovered.status, "complete");
        assert.equal(recovered.remixVersionId, version.id);
        assert.equal(published.length, 1);
        const bytes = await readFile(
          path.join(process.env.WAVEYARD_STORAGE_DIR, published[0].storageKey),
        );
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          published[0].checksumSha256,
        );
        const decoded = synth.decodeWav16(new Uint8Array(bytes));
        assert.equal(decoded.samples.length, expected.samples.length);
        let error = 0;
        for (let i = 0; i < decoded.samples.length; i++)
          error = Math.max(
            error,
            Math.abs(decoded.samples[i] - expected.samples[i]),
          );
        assert.ok(error < 0.00015, stage + " PCM error " + error);
        console.log(
          JSON.stringify({
            kind: "real-Redis-BullMQ-FX-interruption",
            stage,
            queueState: await record.getState(),
            databaseState: recovered.status,
            assets: published.length,
            attempts: recovered.attempts,
            maxError: error,
            sha256: published[0].checksumSha256,
          }),
        );
      }
      const media = await import(
        path.join(cwd, "src/app/api/exports/[id]/media/route.ts")
      );
      const request = () =>
        new Request(
          "http://localhost/api/exports/" + job.id + "/media?download=1",
          { headers: { host: "localhost" } },
        );
      const context = { params: Promise.resolve({ id: job.id }) };
      const bad = Buffer.from(original);
      bad[100] ^= 1;
      await writeFile(output, bad);
      try {
        const corrupt = await media.GET(request(), context);
        assert.equal(corrupt.status, 422);
        assert.equal(
          (
            await database.db
              .select()
              .from(schema.exportJobs)
              .where(eq(schema.exportJobs.id, job.id))
          )[0].status,
          "failed",
        );
      } finally {
        await writeFile(output, original);
      }
      const retried = await api("exports/[id]/retry", "POST", {}, job.id);
      assert.equal(retried.job.status, "queued");
      await queued.waitUntilFinished(events, 20000);
      assert.equal(
        (
          await database.db
            .select()
            .from(schema.exportJobs)
            .where(eq(schema.exportJobs.id, job.id))
        )[0].status,
        "complete",
      );
      const download = await media.GET(request(), context);
      assert.equal(download.status, 200);
      assert.deepEqual(readStudioExportBundle(Buffer.from(await download.arrayBuffer()), { jobId: job.id }).media, original);
      assert.equal(
        (
          await database.db
            .select()
            .from(schema.exportAssets)
            .where(eq(schema.exportAssets.exportJobId, job.id))
        ).length,
        1,
      );
    } finally {
      for (const child of children) {
        try {
          process.kill(-child.pid, "SIGCONT");
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      await events?.close();
      await queue?.close();
      await (
        await import(path.join(cwd, "src/lib/waveyard/queue.ts"))
      ).closeAllQueues?.();
      await database?.pool.end();
      await f?.close();
      redis?.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  },
);
