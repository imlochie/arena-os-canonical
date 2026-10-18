/** Opt-in API acceptance against a RUNNING, PREPARED local Arena instance.
 * No models/downloads/doubles/fixture audio, no Electron/UI acceptance claim.
 * Keeps created project and evidence on success OR failure. Does not install
 * anything, accept model terms or delete user data. See --help.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { computeSourceIdentity } from "./lib/staged-identity.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, url: { type: "string" }, input: { type: "string" },
  checkpoint: { type: "string" }, out: { type: "string" }, "real-music": { type: "boolean" },
} });
if (values.help) {
  console.log("node scripts/waveyard-real-music.mjs --url http://127.0.0.1:PORT --input /music/song.wav --checkpoint /models/5c90dfd2-34c22ccb.th --out /evidence/run-UNIQUE --real-music\nRequires the already-prepared six-stem engine on that Arena host and local FFmpeg/FFprobe (ARENA_FFMPEG_PATH / ARENA_FFPROBE_PATH, platform npm packages or PATH). Authorises creation of a new project, upload, inference, edit, versions and export. Never installs models or removes the project. Do not supply synthetic fixtures. This verifies HTTP/runtime/audio, NOT UI interaction, Electron, subjective stem quality or restart recovery.");
  process.exit(0);
}
if (!values.url || !values.input || !values.checkpoint || !values.out || !values["real-music"]) throw new Error("Explicit --url, --input, --checkpoint, --out and --real-music are required. See --help.");
const base = new URL(values.url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:" || base.username || base.password || base.pathname !== "/") throw new Error("Use the local Arena HTTP origin only; credentials/remote origins/path prefixes are not accepted.");
const directory = path.resolve(values.out);
if (existsSync(directory)) throw new Error("Evidence directory already exists. Choose a new path to preserve previous runs.");
mkdirSync(directory, { recursive: true });
const report = { ok: false, observedAt: new Date().toISOString(), source: computeSourceIdentity(process.cwd()), node: process.version, steps: [], limitations: ["Not Electron or room UI acceptance", "No application restart exercised", "No subjective listening assessment; inspect the retained stems", "The caller attests input is real music; this runner does not classify content", "Server torch/torchaudio versions still require host-side capture; Demucs version is retained in stem modelVersion"] };
const persist = () => writeFileSync(path.join(directory, "music.json"), JSON.stringify(report, null, 2));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function check(name, ok, detail) {
  report.steps.push({ name, ok: Boolean(ok), detail }); persist();
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) throw new Error(name);
}
const api = async (pathname, init) => {
  const response = await fetch(new URL(pathname, base), { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  return body;
};
const post = (pathname, body) => api(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function until(pathname, select) {
  const deadline = Date.now() + 3_600_000;
  while (Date.now() < deadline) {
    const body = await api(pathname);
    const result = select(body);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${pathname}`);
}
function tool(name) {
  const override = process.env[`ARENA_${name.toUpperCase()}_PATH`];
  const bundled = path.join(process.cwd(), "node_modules", `@${name}-installer`, `${process.platform}-${process.arch}`, name + (process.platform === "win32" ? ".exe" : ""));
  return override || (existsSync(bundled) ? bundled : name);
}
function inspect(filename) {
  const metadata = JSON.parse(execFileSync(tool("ffprobe"), ["-v", "error", "-show_format", "-show_streams", "-of", "json", filename], { timeout: 120_000, encoding: "utf8" }));
  const decoded = spawnSync(tool("ffmpeg"), ["-v", "error", "-i", filename, "-f", "null", "-"], { timeout: 120_000, encoding: "utf8" });
  check(`decode ${path.basename(filename)}`, decoded.status === 0 && Number(metadata.format?.duration) > 0 && metadata.streams?.some((stream) => stream.codec_type === "audio"), { metadata, decoderError: decoded.stderr });
  return metadata;
}
try {
  const input = readFileSync(values.input), checkpoint = readFileSync(values.checkpoint);
  report.input = { filename: path.basename(values.input), sha256: sha(input), size: input.length };
  report.checkpoint = { filename: path.basename(values.checkpoint), sha256: sha(checkpoint), size: checkpoint.length };
  check("checkpoint matches production Demucs integrity prefix", report.checkpoint.sha256.startsWith("34c22ccb"));
  report.input.metadata = inspect(values.input);
  report.ffmpeg = execFileSync(tool("ffmpeg"), ["-version"], { encoding: "utf8", timeout: 10_000 }).split("\n")[0];
  const status = await api("/api/waveyard/separation/models"); report.engine = status.deep;
  check("six-stem engine prepared (prerequisite, not inference proof)", status.deep?.prepared && status.deep?.modelId === "deep_6s", status.deep);
  const { project } = await post("/api/waveyard/projects", { title: `Real music acceptance ${report.observedAt}` }); report.projectId = project.id; persist();
  const form = new FormData(); form.set("projectId", project.id); form.set("model", "deep_6s"); form.set("device", "auto");
  form.set("file", new Blob([input]), path.basename(values.input));
  const upload = await api("/api/uploads", { method: "POST", body: form }); report.upload = upload; persist();
  const projectPath = `/api/waveyard/projects/${project.id}`;
  const job = await until(projectPath, (body) => body.jobs?.find((job) => job.type === "separation" && ["complete", "failed", "cancelled"].includes(job.status)));
  check("actual deep job completed", job.status === "complete", job); report.job = job;
  const sourceAnalysis = await until(projectPath, (body) => body.sources?.find((source) => source.id === upload.source.id && ["complete", "failed"].includes(source.analysis?.status)));
  check("real source analysis completed with the original checksum", sourceAnalysis.analysis.status === "complete" && sourceAnalysis.checksumSha256 === report.input.sha256, sourceAnalysis.analysis);
  const workspace = await api(projectPath); report.sources = workspace.sources; report.stems = workspace.stems;
  const expected = ["bass", "drums", "guitar", "other", "piano", "vocals"];
  check("six correctly attributed model outputs", workspace.stems?.length === 6 && JSON.stringify(workspace.stems.map((stem) => stem.stemType).sort()) === JSON.stringify(expected) && workspace.stems.every((stem) => stem.engine === "demucs" && stem.model === "deep_6s" && stem.modelVersion.includes("htdemucs_6s@5c90dfd2-34c22ccb/demucs-") && stem.sourceAssetId === upload.source.id), workspace.stems);
  report.outputs = [];
  for (const stem of workspace.stems) {
    const response = await fetch(new URL(`/api/assets/${stem.id}?download=1`, base));
    check(`download ${stem.stemType}`, response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(`checksum ${stem.stemType}`, sha(bytes) === stem.checksumSha256);
    const filename = path.join(directory, `${stem.stemType}.wav`); writeFileSync(filename, bytes);
    report.outputs.push({ id: stem.id, sha256: sha(bytes), metadata: inspect(filename) });
  }
  const { remix } = await post(`${projectPath}/remixes`, { name: "Model outputs → saved mix" }); report.remixId = remix.id;
  const state = await api(`/api/remixes/${remix.id}`);
  check("arrangement uses only the model outputs", state.tracks.length === 6 && state.tracks.every((track) => workspace.stems.some((stem) => stem.id === track.stemAssetId) && track.clips.length > 0 && track.clips.every((clip) => clip.stemAssetId === track.stemAssetId)));
  const edited = { ...state.remix, masterVolume: 0.5, tracks: state.tracks, automation: state.automation };
  await api(`/api/remixes/${remix.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(edited) });
  check("saved edit reopens", (await api(`/api/remixes/${remix.id}`)).remix.masterVolume === 0.5);
  const { version } = await post(`/api/remixes/${remix.id}/versions`, { name: "Genuine separation mix" }); report.versionId = version.id;
  const { job: exportJob } = await post(`/api/remix-versions/${version.id}/exports`, { format: "wav" });
  const rendered = await until(`/api/remix-versions/${version.id}/exports`, (body) => body.exports?.find((job) => job.id === exportJob.id && ["complete", "failed"].includes(job.status)));
  check("actual model-output mix rendered", rendered.status === "complete", rendered); report.export = rendered;
  const response = await fetch(new URL(`/api/exports/${rendered.id}/media?download=1`, base)); check("mix downloadable", response.ok);
  const bytes = Buffer.from(await response.arrayBuffer()), filename = path.join(directory, "mix.wav"); writeFileSync(filename, bytes);
  report.mix = { sha256: sha(bytes), metadata: inspect(filename) };
  const level = spawnSync(tool("ffmpeg"), ["-v", "info", "-i", filename, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", timeout: 120_000 });
  const meanDb = /mean_volume:\s*(-?[\d.]+) dB/.exec(level.stderr ?? "")?.[1];
  report.mix.meanDb = meanDb === undefined ? null : Number(meanDb);
  check("rendered mix has detectable signal", level.status === 0 && report.mix.meanDb !== null && report.mix.meanDb > -80, { meanDb: report.mix.meanDb });
  const expectedSeconds = Math.max(...state.tracks.flatMap((track) => track.clips.map((clip) => (clip.timelineStartMs + clip.durationMs) / 1000)));
  check("mix duration matches persisted arrangement", Math.abs(Number(report.mix.metadata.format.duration) - expectedSeconds) < 0.03);
  await api(`/api/remixes/${remix.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...edited, masterVolume: 0.25 }) });
  await post(`/api/remixes/${remix.id}/versions/${version.id}/restore`, {});
  check("immutable version restores saved mix", (await api(`/api/remixes/${remix.id}`)).remix.masterVolume === 0.5);
  report.ok = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { persist(); console.log(`Evidence retained: ${path.join(directory, "music.json")}`); }
