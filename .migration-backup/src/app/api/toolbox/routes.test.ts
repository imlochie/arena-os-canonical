/**
 * Route tests for /api/toolbox — the local converter API.
 *
 * Covers: the GET manifest (jobs + presets + honest hardware line), real
 * multipart upload with probing, the clean 400 for files ffmpeg can't read,
 * a real end-to-end conversion driven through the route (upload → convert →
 * poll → download), path-safety rejection, and job deletion. No PG needed.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execTool } from "../../../lib/waveyard/ffmpeg";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GET, POST } = await import("./route");
const { resetToolboxForTests, TOOLBOX_IN, TOOLBOX_OUT, ensureToolboxDirs } = await import("@/lib/toolbox/convert");

const BASE = "http://local/api/toolbox";
let scratch: string | null = null;

after(async () => {
  const fs = await import("node:fs/promises");
  for (const dir of [TOOLBOX_IN, TOOLBOX_OUT]) {
    for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
      await fs.rm(`${dir}/${entry}`, { force: true, recursive: true }).catch(() => {});
    }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

async function getJson(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  return (await response.json()) as Record<string, unknown>;
}

async function waitForDone(id: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const manifest = await getJson(await GET(new Request(BASE)));
    const job = (manifest.jobs as Record<string, unknown>[]).find((j) => j.id === id);
    if (!job) throw new Error("job vanished from the manifest");
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job timed out in status=${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("GET returns the manifest: presets, hardware honesty, empty queue", async () => {
  resetToolboxForTests();
  await ensureToolboxDirs();
  const manifest = await getJson(await GET(new Request(BASE)));
  const presets = manifest.presets as { id: string; kind: string }[];
  assert.equal(presets.length >= 15, true, "all presets exposed");
  assert.ok(presets.some((p) => p.id === "fast-1080p" && p.kind === "video"));
  assert.ok(presets.some((p) => p.id === "image-webp" && p.kind === "image"));
  const hardware = manifest.hardware as string | null;
  assert.ok(hardware === null || /^h264_/.test(hardware));
  assert.deepEqual(manifest.jobs, []);
});

test("POST multipart uploads and probes a real image", async () => {
  scratch = await mkdtemp(join(tmpdir(), "toolbox-route-"));
  const pngPath = join(scratch, "dot.png");
  await execTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=navy:s=64x64", "-frames:v", "1", pngPath]);
  const bytes = await readFile(pngPath);

  const form = new FormData();
  form.append("file", new File([bytes], "dot.png", { type: "image/png" }));
  const response = await POST(new Request(BASE, { method: "POST", body: form }));
  const data = await getJson(response);
  assert.equal(response.status, 201);
  assert.equal((data.probe as Record<string, unknown>).kind, "image");
  assert.equal(typeof data.path, "string");
  assert.ok((data.size as number) > 0);
});

test("POST multipart with a text file gets a clean 400, nothing kept", async () => {
  const form = new FormData();
  form.append("file", new File([new TextEncoder().encode("definitely not media")], "fake.mp4", { type: "video/mp4" }));
  const response = await POST(new Request(BASE, { method: "POST", body: form }));
  assert.equal(response.status, 400);
  const data = await getJson(response);
  assert.equal(data.error, "not_media");
});

test("full flow through the route: upload → convert → poll → download → clear", async () => {
  // A real 1-second video so the conversion is a genuine ffmpeg run.
  const mp4Path = join(scratch!, "tiny.mp4");
  await execTool("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast",
    mp4Path,
  ]);
  const form = new FormData();
  form.append("file", new File([await readFile(mp4Path)], "tiny.mp4", { type: "video/mp4" }));
  const uploadResponse = await POST(new Request(BASE, { method: "POST", body: form }));
  const uploaded = await getJson(uploadResponse);
  assert.equal(uploadResponse.status, 201);

  const convertResponse = await POST(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convert", path: uploaded.path, name: "tiny.mp4", presetId: "fast-480p" }),
    }),
  );
  const convertData = await getJson(convertResponse);
  assert.equal(convertResponse.status, 201);
  const jobId = (convertData.job as Record<string, unknown>).id as string;

  const done = await waitForDone(jobId);
  assert.equal(done.status, "done");
  assert.equal(done.outCodec, "h264");

  const download = await GET(new Request(`${BASE}?file=1&id=${jobId}`));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "video/mp4");
  assert.ok(Number(download.headers.get("content-length")) > 0);
  const body = new Uint8Array(await download.arrayBuffer());
  assert.ok(body.length > 100);

  const missing = await GET(new Request(`${BASE}?file=1&id=nope`));
  assert.equal(missing.status, 404);

  const del = await POST(
    new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: jobId }) }),
  );
  const delData = await getJson(del);
  assert.equal(delData.removed, true);
});

test("convert rejects paths outside the toolbox upload dir", async () => {
  const outside = join(scratch!, "evil.txt");
  await writeFile(outside, "nope");
  const response = await POST(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convert", path: outside, name: "evil.txt", presetId: "fast-480p" }),
    }),
  );
  assert.equal(response.status, 400);
  const data = await getJson(response);
  assert.equal(data.error, "convert_failed");
});

test("convert rejects unknown presets and unknown actions", async () => {
  const badPreset = await POST(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convert", path: "/dev/null", name: "x", presetId: "definitely-not-real" }),
    }),
  );
  assert.equal(badPreset.status, 400);
  const badAction = await POST(
    new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "explode" }) }),
  );
  assert.equal(badAction.status, 400);
});

test("custom jobs persist their knobs through execution", async () => {
  const mp4Path = join(scratch!, "wide.mp4");
  await execTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=200x100:rate=10:duration=1", "-c:v", "libx264", "-preset", "ultrafast", mp4Path]);
  const form = new FormData();
  form.append("file", new File([await readFile(mp4Path)], "wide.mp4", { type: "video/mp4" }));
  const uploaded = await getJson(await POST(new Request(BASE, { method: "POST", body: form })));

  const response = await POST(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "convert",
        path: uploaded.path,
        name: "wide.mp4",
        presetId: "custom",
        width: 160,
        fps: 24,
        quality: 28,
      }),
    }),
  );
  const data = await getJson(response);
  assert.equal(response.status, 201);
  const jobId = (data.job as Record<string, unknown>).id as string;
  const done = await waitForDone(jobId);
  assert.equal(done.status, "done");
  assert.equal(done.outCodec, "h264");
  assert.equal((done.custom as Record<string, unknown>).width, 160);
  assert.ok(String(done.outputName).endsWith(".mp4"));
});
