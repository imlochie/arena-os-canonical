// Real built Next server + owned PG/files + Chromium. This exercises delivery,
// not generated intelligence: the export row/audio are explicit fault fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { chromium } from "playwright-core";
import { missionPostgres } from "../helpers/mission-postgres.ts";
import * as schema from "../../src/db/waveyardSchema.ts";
import { LOCAL_OWNER_ID } from "../../src/db/schema.ts";
import { LocalStorageProvider } from "../../src/lib/waveyard/storage.ts";
import { encodeWav16 } from "../../src/lib/waveyard/mixer/synth.ts";
test(
  "built Next media delivery preserves byte identity, Unicode downloads and failed-publication state",
  { timeout: 120000 },
  async () => {
    const evidence =
      process.env.ARENA_MEDIA_DELIVERY_EVIDENCE_DIR ||
      ".data/media-delivery-acceptance";
    const { mkdir } = await import("node:fs/promises");
    await mkdir(evidence, { recursive: true });
    const receipt = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      scope:
        "Built production Next HTTP + real PostgreSQL/filesystem + actual Chromium download. Controlled owned audio, seeded export row, NOT inference or whole-app UI acceptance.",
      checks: [],
      error: null,
    };
    const root = await mkdtemp(join(tmpdir(), "arena-real-http-"));
    let pg, server, browser;
    let logs = "";
    try {
      pg = await missionPostgres();
      const db = pg.database;
      const storage = new LocalStorageProvider(join(root, "private"));
      const bytes = Buffer.from(
        encodeWav16(
          Float32Array.from(
            { length: 88200 },
            (_, i) => Math.sin(i * 0.04) * 0.2,
          ),
          44100,
        ),
      );
      const filename = "夜の演奏 🎵.wav",
        input = join(root, "input.wav");
      await writeFile(input, bytes);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const [project] = await db
        .insert(schema.projects)
        .values({
          ownerId: LOCAL_OWNER_ID,
          title: "Owned HTTP reliability fixture",
        })
        .returning();
      const sourceKey = `projects/${project.id}/source/${randomUUID()}.wav`;
      await storage.putFile(sourceKey, input);
      const [source] = await db
        .insert(schema.sourceAssets)
        .values({
          projectId: project.id,
          storageKey: sourceKey,
          originalFilename: filename,
          mimeType: "audio/wav",
          checksumSha256: sha,
          durationSeconds: 1,
          sampleRate: 44100,
          channels: 2,
          codec: "pcm_s16le",
          fileSizeBytes: bytes.length,
        })
        .returning();
      const [session] = await db
        .insert(schema.remixSessions)
        .values({
          projectId: project.id,
          ownerId: LOCAL_OWNER_ID,
          name: "Owned fault fixture",
        })
        .returning();
      const [version] = await db
        .insert(schema.remixVersions)
        .values({
          remixSessionId: session.id,
          createdById: LOCAL_OWNER_ID,
          name: "Controlled export fixture",
          snapshot: "{}",
        })
        .returning();
      const [job] = await db
        .insert(schema.exportJobs)
        .values({
          projectId: project.id,
          remixSessionId: session.id,
          remixVersionId: version.id,
          requestedById: LOCAL_OWNER_ID,
          status: "complete",
          stage: "complete",
          idempotencyKey: randomUUID(),
        })
        .returning();
      const key = `projects/${project.id}/export/${randomUUID()}.wav`;
      await storage.putFile(key, input);
      const [asset] = await db
        .insert(schema.exportAssets)
        .values({
          projectId: project.id,
          exportJobId: job.id,
          remixVersionId: version.id,
          storageKey: key,
          filename,
          checksumSha256: sha,
          durationSeconds: 1,
          sampleRate: 44100,
          channels: 2,
          codec: "pcm_s16le",
          format: "wav",
          fileSizeBytes: bytes.length,
        })
        .returning();
      const portServer = createServer();
      await new Promise((r) => portServer.listen(0, "0.0.0.0", r));
      const port = portServer.address().port;
      await new Promise((r) => portServer.close(r));
      server = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "start",
          "--hostname",
          "0.0.0.0",
          "--port",
          String(port),
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: pg.url,
            WAVEYARD_STORAGE_DIR: join(root, "private"),
            WAVEYARD_LOCAL_WORKER: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Next readiness deadline")),
          60000,
        );
        const take = (chunk) => {
          logs += chunk.toString();
          if (/Ready in/.test(logs)) {
            clearTimeout(timeout);
            resolve();
          }
        };
        server.stdout.on("data", take);
        server.stderr.on("data", take);
        server.once("error", error => { clearTimeout(timeout); reject(error); });
        server.once("exit", (code) => {
          clearTimeout(timeout);
          reject(Error(`Next exited ${code}: ${logs}`));
        });
      });
      const base = `http://127.0.0.1:${port}`,
        params = {
          visibility: "public",
          rightsAcknowledged: true,
          licenseCode: "all-rights-reserved",
          publishedExportAssetId: asset.id,
          downloadPermission: "public",
        };
      const publish = () =>
        fetch(`${base}/api/waveyard/projects/${project.id}/publication`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
      const published = await publish();
      assert.equal(published.status, 200, await published.text());
      receipt.checks.push(
        "actual HTTP publication accepts exact acknowledged WAV",
      );
      for (const path of [
        `/api/assets/${source.id}`,
        `/api/exports/${job.id}/media`,
        `/api/public/projects/${project.id}/release`,
      ]) {
        const response = await fetch(base + path, {
          headers: { Range: "bytes=-100" },
        });
        assert.equal(response.status, 206);
        assert.equal(
          response.headers.get("content-range"),
          `bytes ${bytes.length - 100}-${bytes.length - 1}/${bytes.length}`,
        );
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          bytes.subarray(-100),
        );
        receipt.checks.push(`HTTP exact suffix ${path}`);
      }
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        args: ["--no-sandbox"],
        headless: true,
        env: {
          ...process.env,
          ...(process.platform === "linux"
            ? { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
            : {}),
        },
      });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      await page.goto(base + "/waveyard");
      for (const path of [
        `/api/assets/${source.id}?download=1`,
        `/api/public/projects/${project.id}/release?download=1`,
      ]) {
        const inspect = await fetch(base + path);
        assert.equal(inspect.status, 200);
        assert.match(
          inspect.headers.get("content-disposition") ?? "",
          /filename\*=UTF-8''/,
        );
        await inspect.arrayBuffer();
        const pending = page.waitForEvent("download");
        await page.goto(base + path).catch((error) => {
          if (!/Download is starting|ERR_ABORTED/.test(error.message))
            throw error;
        });
        const download = await pending;
        assert.equal(await download.failure(), null);
        assert.equal(download.suggestedFilename(), filename);
        const saved = await download.path();
        assert.ok(saved);
        assert.deepEqual(await readFile(saved), bytes);
        receipt.checks.push(
          `Chromium suggested filename + exact downloaded bytes ${path}`,
        );
      }
      const bad = Buffer.from(bytes);
      bad[100] ^= 1;
      await writeFile(storage.getLocalPath(sourceKey), bad);
      await writeFile(storage.getLocalPath(key), bad);
      for (const path of [
        `/api/assets/${source.id}`,
        `/api/public/projects/${project.id}/release`,
      ]) {
        const response = await fetch(base + path, {
          headers: { Range: "bytes=-100" },
        });
        assert.equal(response.status, 422, await response.text());
        receipt.checks.push(`HTTP rejects same-size corruption ${path}`);
      }
      await db
        .update(schema.projects)
        .set({
          visibility: "private",
          publicationStatus: "draft",
          publishedExportAssetId: null,
        })
        .where(eq(schema.projects.id, project.id));
      const refused = await publish();
      assert.equal(refused.status, 422, await refused.text());
      const [unchanged] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, project.id));
      assert.equal(unchanged.publicationStatus, "draft");
      receipt.checks.push("HTTP corrupt publication leaves project draft");
      await storage.putFile(sourceKey, input);
      await storage.putFile(key, input);
      const repaired = await publish();
      assert.equal(repaired.status, 200, await repaired.text());
      receipt.checks.push(
        "HTTP repaired same object publishes without replacement",
      );
    } catch (error) {
      receipt.error = String(error.stack ?? error);
      throw error;
    } finally {
      await browser?.close();
      if (server?.pid && server.exitCode === null && server.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
          timer.unref();
          server.once("exit", () => { clearTimeout(timer); resolve(); });
          server.kill("SIGTERM");
        });
      }
      await writeFile(join(evidence, "next.log"), logs);
      await pg?.close();
      await rm(root, { recursive: true, force: true });
      await writeFile(
        join(evidence, "receipt.json"),
        JSON.stringify(receipt, null, 2),
      );
      console.log(JSON.stringify(receipt, null, 2));
    }
  },
);
