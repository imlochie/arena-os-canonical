import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { addTrackFromAudioFile } from "@/lib/waveyard/library/service";
import { OutboundUrlError, assertOutboundUrl } from "@/lib/security/outbound-url";
import { requireApiAccess } from "@/lib/security/api-access";
import { resolveExecutable } from "@/lib/capabilities/resolver";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Personal ingest (Wave 3, personal-use stance): pull audio from a URL with
 * yt-dlp (owner-installed binary) and run it through the REAL library intake
 * (checksum, dedupe, separation queue). Honest states only:
 *   - no yt-dlp → 503 with the install hint
 *   - yt-dlp fails → its stderr, nothing ingested
 * Never mocked, never bypassed.
 */

const MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 540_000;
const REQUEST_BODY_LIMIT = 64 * 1024;

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  watch?: { dir: string; maxBytes: number },
): Promise<{ code: number; stdout: string; stderr: string; exceededLimit: boolean }> {
  return new Promise((resolve) => {
    let exceededLimit = false;
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (poll) clearInterval(poll);
      resolve({ code: error === null ? 0 : (error as { code?: number })?.code ?? 1, stdout: String(stdout), stderr: String(stderr), exceededLimit });
    });
    // --max-filesize cannot bound streams of unknown length; cap what lands on
    // disk and kill the tool when the temp directory outgrows the limit.
    const poll = watch
      ? setInterval(() => {
          void directoryBytes(watch.dir).then((bytes) => {
            if (bytes > watch.maxBytes && !exceededLimit) {
              exceededLimit = true;
              child.kill();
            }
          });
        }, 1000)
      : null;
  });
}

async function directoryBytes(dir: string): Promise<number> {
  try {
    const names = await readdir(dir);
    const sizes = await Promise.all(names.map((name) => stat(join(dir, name)).then((s) => s.size).catch(() => 0)));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

/**
 * Resolved yt-dlp path plus the result of really executing it, memoised.
 *
 * The probe stays a real `yt-dlp --version` execution — it is what makes
 * "available" honest — but it is no longer paid on every request: the library
 * page asks on open and every URL ingest asks again, and starting a process is
 * the expensive half on Windows (~60-100 ms, plus Defender inspecting the
 * binary). Path resolution still runs first on every call, so an uninstalled,
 * overridden or moved binary is observed immediately; a probe that failed is
 * retried after the TTL rather than cached as a permanent verdict.
 */
const YTDLP_PROBE_TTL_MS = 60_000;
let ytDlpProbe: { path: string; at: number; ok: boolean } | null = null;

async function resolveYtDlp(): Promise<string | null> {
  // override -> bundled (app/bin) -> system PATH, always an absolute path.
  const found = resolveExecutable("yt-dlp", { envVar: "ARENA_YTDLP_PATH" });
  if (found === null) {
    ytDlpProbe = null;
    return null;
  }
  if (ytDlpProbe !== null && ytDlpProbe.path === found.path && Date.now() - ytDlpProbe.at < YTDLP_PROBE_TTL_MS) {
    return ytDlpProbe.ok ? found.path : null;
  }
  const probe = await run(found.path, ["--version"], 8000);
  const ok = probe.code === 0 && probe.stdout.trim().length > 0;
  ytDlpProbe = { path: found.path, at: Date.now(), ok };
  return ok ? found.path : null;
}

export async function GET(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  return NextResponse.json({ available: (await resolveYtDlp()) !== null, hint: "Set ARENA_YTDLP_PATH or install yt-dlp on the PATH." });
}

export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > REQUEST_BODY_LIMIT) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  let body: { url?: string; title?: string; artist?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return NextResponse.json({ error: "a valid http(s) URL is required" }, { status: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json({ error: "only http(s) URLs are supported" }, { status: 400 });
  }
  // SSRF gate: ingest fetches a caller-controlled URL through a child
  // process, so the destination is validated (public endpoints only, every
  // DNS answer checked) BEFORE yt-dlp runs. Residual risk, documented: yt-dlp
  // follows redirects internally, so a public host redirecting to an internal
  // one mid-download is outside this gate's reach.
  try {
    await assertOutboundUrl(url, "public");
  } catch (error) {
    const detail = error instanceof OutboundUrlError ? error.message : "destination refused";
    return NextResponse.json({ error: `Ingest refused: ${detail}` }, { status: 400 });
  }

  const bin = await resolveYtDlp();
  if (!bin) {
    return NextResponse.json(
      { error: "yt-dlp is not installed. Install it (https://github.com/yt-dlp/yt-dlp) or set ARENA_YTDLP_PATH — ingest never fakes a download." },
      { status: 503 },
    );
  }

  const user = await requireUser();
  const dir = await mkdtemp(join(tmpdir(), "arena-ingest-"));
  try {
    const output = join(dir, "dl.%(ext)s");
    const download = await run(
      bin,
      // "--" ends option parsing: a URL starting with "-" can never become a flag.
      ["-f", "bestaudio/best", "--no-playlist", "--max-filesize", String(MAX_BYTES), "--socket-timeout", "30", "-o", output, "--no-progress", "--", raw],
      DOWNLOAD_TIMEOUT_MS,
      { dir, maxBytes: MAX_BYTES },
    );
    if (download.exceededLimit) {
      return NextResponse.json({ error: `download exceeded the ${MAX_BYTES}-byte limit and was stopped` }, { status: 413 });
    }
    if (download.code !== 0) {
      return NextResponse.json({ error: `yt-dlp failed: ${download.stderr.trim().slice(0, 500) || "unknown error"}` }, { status: 422 });
    }
    const files = await readdir(dir);
    const media = files.filter((f) => /\.(mp3|wav|flac|m4a|aac|ogg|opus|webm|mp4)$/i.test(f));
    if (media.length === 0) return NextResponse.json({ error: "yt-dlp produced no media file" }, { status: 422 });
    const file = media[0];
    const info = await stat(join(dir, file));
    if (info.size <= 0 || info.size > MAX_BYTES) return NextResponse.json({ error: `file out of size bounds (${info.size} bytes)` }, { status: 413 });

    const result = await addTrackFromAudioFile({
      ownerId: user.id,
      filePath: join(dir, file),
      filename: file,
      mimeType: "application/octet-stream",
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
      artist: typeof body.artist === "string" ? body.artist.slice(0, 200) : undefined,
    });
    return NextResponse.json({ track: result.track, created: result.created, separationQueued: result.separationQueued }, { status: 201 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
