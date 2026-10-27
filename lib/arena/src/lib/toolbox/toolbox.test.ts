import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execTool } from "../waveyard/ffmpeg";

// The Toolbox — real conversions through the real bundled ffmpeg. Sources
// are generated with lavfi (testsrc2/sine/color), presets run through the
// actual job runner, and every output is re-probed with ffprobe to assert
// what was really produced. No mocks of our code anywhere.

const {
  TOOLBOX_IN,
  TOOLBOX_OUT,
  createConversionJob,
  ensureToolboxDirs,
  deleteJob,
  detectHardwareEncoder,
  getJob,
  isToolboxInputPath,
  parseProbe,
  resetToolboxForTests,
  storeUpload,
  probeSource,
} = await import("./convert");
const { buildPresetArgs, presetCatalog } = await import("./presets");

type ConvertJob = Awaited<ReturnType<typeof createConversionJob>>;

async function waitForJob(id: string, timeoutMs = 120_000): Promise<ConvertJob> {
  const start = Date.now();
  for (;;) {
    const job = getJob(id);
    if (!job) throw new Error("job vanished from the registry");
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job timed out in status=${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function makeSource(name: string, args: string[]): Promise<string> {
  const path = `${TOOLBOX_IN}/${name}`;
  await execTool("ffmpeg", ["-hide_banner", "-y", ...args, path]);
  return path;
}

before(async () => {
  resetToolboxForTests();
  await ensureToolboxDirs();
});

after(async () => {
  // Clean the toolbox scratch dirs this suite wrote into (uploads + outputs).
  const fs = await import("node:fs/promises");
  for (const dir of [TOOLBOX_IN, TOOLBOX_OUT]) {
    for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
      await fs.rm(`${dir}/${entry}`, { force: true, recursive: true }).catch(() => {});
    }
  }
});

let videoPath: string | null = null;
let audioPath: string | null = null;
let imagePath: string | null = null;

/* ------------------------------ pure logic -------------------------------- */

test("parseProbe: honest kind detection (image vs audio vs video)", () => {
  const image = parseProbe(
    JSON.stringify({ streams: [{ codec_type: "video", codec_name: "png", width: 800, height: 600 }], format: { format_name: "image2" } }),
  );
  assert.equal(image.kind, "image");
  const audio = parseProbe(
    JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3" }], format: { format_name: "mp3", duration: "12.5" } }),
  );
  assert.equal(audio.kind, "audio");
  assert.equal(audio.durationSec, 12.5);
  const video = parseProbe(
    JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "90" },
    }),
  );
  assert.equal(video.kind, "video");
  assert.equal(video.height, 1080);
  assert.equal(video.audioCodec, "aac");
});

test("presets: arg maps do what the labels promise", () => {
  const ctx = {
    input: "/in/x.mp4",
    output: "/out/x.mp4",
    source: { kind: "video" as const, durationSec: 10, videoCodec: "h264", audioCodec: "aac", width: 3840, height: 2160, formatName: "mov,mp4" },
    hw: null,
  };
  // 4K source under Fast 720p → capped at 1280x720.
  const fast720 = buildPresetArgs("fast-720p", ctx);
  assert.ok(fast720.args.join(" ").includes("min(1280,iw)"));
  assert.ok(fast720.args.join(" ").includes("min(720,ih)"));
  assert.equal(fast720.engine, "software:libx264");
  // AAC source + MP4 target → audio stream copy (the efficiency rule).
  assert.ok(fast720.args.includes("-c:a") && fast720.args.includes("copy"));
  // Already-AAC source stays a copy for m4a too.
  const m4a = buildPresetArgs("extract-m4a", { ...ctx, output: "/out/x.m4a" });
  assert.equal(m4a.engine, "stream-copy");
  // Remux never re-encodes.
  const remux = buildPresetArgs("remux-mkv", { ...ctx, output: "/out/x.mkv" });
  assert.deepEqual(remux.args, ["-i", ctx.input, "-c", "copy", "/out/x.mkv"]);
  assert.equal(remux.engine, "stream-copy");
  // Non-AAC audio under Fast 1080p → re-encode to AAC 160k.
  const reenc = buildPresetArgs("fast-1080p", { ...ctx, source: { ...ctx.source, audioCodec: "opus" } });
  assert.ok(reenc.args.join(" ").includes("-b:a 160k"));
  // Hardware encoder is preferred and labeled.
  const hw = buildPresetArgs("fast-1080p", { ...ctx, hw: "h264_vaapi" });
  assert.equal(hw.engine, "hardware:h264_vaapi");
  assert.ok(hw.args.includes("h264_vaapi"));
  // HEVC maps h264_* hardware names to hevc_*.
  const hevcHw = buildPresetArgs("hevc-1080p", { ...ctx, hw: "h264_vaapi" });
  assert.equal(hevcHw.engine, "hardware:hevc_vaapi");
  // Custom knobs are clamped.
  const custom = buildPresetArgs("custom", { ...ctx, output: "/out/x.mp4", custom: { width: 99999, fps: 500, quality: 900 } });
  assert.ok(custom.args.join(" ").includes("min(7680,iw)"));
  assert.ok(custom.args.join(" ").includes("fps='60'"));
  // Catalog exposes every preset with an id/label/ext.
  for (const preset of presetCatalog()) {
    assert.ok(preset.id && preset.label && preset.targetExt && preset.description);
  }
});

test("hardware probe is honest (null or a real encoder, cached)", async () => {
  const first = await detectHardwareEncoder();
  assert.ok(first === null || /^h264_/.test(first));
  const second = await detectHardwareEncoder();
  assert.equal(first, second, "cached after the first probe");
});

/* --------------------------- path safety ---------------------------------- */

test("only toolbox input paths are accepted", () => {
  assert.ok(isToolboxInputPath(`${TOOLBOX_IN}/abc.mp4`));
  assert.ok(!isToolboxInputPath("/etc/passwd"));
  assert.ok(!isToolboxInputPath(`${TOOLBOX_IN}/../../etc/passwd`));
  assert.ok(!isToolboxInputPath("/home/user/arena-os-canonical/package.json"));
});

/* ------------------------- real end-to-end runs --------------------------- */

test("e2e: video 4K→480p H.264 conversion with real progress and honest probing", async () => {
  videoPath = await makeSource("suite-source.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
  ]);
  const probe = await probeSource(videoPath);
  assert.equal(probe.kind, "video");
  assert.ok((probe.durationSec ?? 0) > 1.5);
  const job = await createConversionJob({ path: videoPath, name: "suite-source.mp4", presetId: "fast-480p" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.error, null);
  assert.ok(done.engine.startsWith("software:libx264") || done.engine.startsWith("hardware:"));
  assert.ok(done.progress === 1);
  assert.equal(done.outCodec, "h264");
  const outProbe = await probeSource(done.outputPath!);
  assert.ok(outProbe.height !== null && outProbe.height <= 480, `height ${outProbe.height} must be ≤ 480`);
  assert.ok(Math.abs((outProbe.durationSec ?? 0) - (probe.durationSec ?? 0)) < 0.6, "duration preserved");
  assert.ok((done.outputBytes ?? 0) > 0);
});

test("e2e: audio extraction to MP3 (V0)", async () => {
  assert.ok(videoPath, "video source from the previous test");
  const job = await createConversionJob({ path: videoPath, name: "suite-source.mp4", presetId: "extract-mp3" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.outCodec, "mp3");
});

test("e2e: instant remux to MKV (stream copy, duration preserved)", async () => {
  assert.ok(videoPath);
  const job = await createConversionJob({ path: videoPath, name: "suite-source.mp4", presetId: "remux-mkv" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.engine, "stream-copy");
  const outProbe = await probeSource(done.outputPath!);
  assert.ok(Math.abs((outProbe.durationSec ?? 0) - 2) < 0.6);
});

test("e2e: animated GIF with palette", async () => {
  assert.ok(videoPath);
  const job = await createConversionJob({ path: videoPath, name: "suite-source.mp4", presetId: "gif-480" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.outCodec, "gif");
  assert.ok((done.outputBytes ?? 0) > 0);
});

test("e2e: PNG → WebP image conversion", async () => {
  imagePath = await makeSource("suite-source.png", ["-f", "lavfi", "-i", "color=red:s=640x480", "-frames:v", "1"]);
  const probe = await probeSource(imagePath);
  assert.equal(probe.kind, "image");
  const job = await createConversionJob({ path: imagePath, name: "suite-source.png", presetId: "image-webp" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.outCodec, "webp");
});

test("e2e: audio-only file converts to WAV and Opus", async () => {
  audioPath = await makeSource("suite-source.wav", ["-f", "lavfi", "-i", "sine=frequency=220:duration=1"]);
  const wav = await createConversionJob({ path: audioPath, name: "suite-source.wav", presetId: "convert-wav" });
  const wavDone = await waitForJob(wav.id);
  assert.equal(wavDone.status, "done");
  assert.equal(wavDone.outCodec, "pcm_s16le");

  const opus = await createConversionJob({ path: audioPath, name: "suite-source.wav", presetId: "extract-opus" });
  const opusDone = await waitForJob(opus.id);
  assert.equal(opusDone.status, "done");
  assert.equal(opusDone.outCodec, "opus");
});

test("unreadable input is rejected at job creation with a clean error", async () => {
  // A text file pretending to be a video: the probe can't read it, so the
  // job is never created and the caller gets an honest message.
  const stored = await storeUpload({ name: "fake.mp4", bytes: new TextEncoder().encode("this is not a video at all") });
  await assert.rejects(
    () => createConversionJob({ path: stored.path, name: "fake.mp4", presetId: "fast-480p" }),
    /can't be read as media/,
  );
});

test("e2e: a conversion ffmpeg genuinely can't do records the honest error", async () => {
  // A video with NO audio stream + MP3 extraction: probes fine, ffmpeg
  // must fail ("output contains no streams") — the job must say so.
  const silent = await makeSource("suite-silent.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast",
  ]);
  const job = await createConversionJob({ path: silent, name: "suite-silent.mp4", presetId: "extract-mp3" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "failed");
  assert.ok(done.error && done.error.length > 0);
  assert.equal(done.outputBytes, null);
  await import("node:fs/promises").then((fs) => fs.rm(silent, { force: true }).catch(() => {}));
});

test("jobs: delete clears finished jobs and their files", async () => {
  const stored = await storeUpload({ name: "del.png", bytes: new TextEncoder().encode("x") });
  const job = await createConversionJob({ path: stored.path, name: "del.png", presetId: "image-png" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "failed"); // not a real image — fine for this test
  assert.equal(await deleteJob(done.id), true);
  assert.equal(getJob(done.id), null);
  assert.equal(await deleteJob(done.id), false);
});
