import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { addTrackFromAudioFile } from "@/lib/waveyard/library/service";
import { OutboundUrlError, assertOutboundUrl } from "@/lib/security/outbound-url";

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

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error === null ? 0 : (error as { code?: number })?.code ?? 1, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function resolveYtDlp(): Promise<string | null> {
  const candidates = [process.env.ARENA_YTDLP_PATH, "yt-dlp", "yt-dlp.exe"].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = await run(candidate, ["--version"], 8000);
    if (probe.code === 0 && probe.stdout.trim().length > 0) return candidate;
  }
  return null;
}

export async function GET() {
  return NextResponse.json({ available: (await resolveYtDlp()) !== null, hint: "Set ARENA_YTDLP_PATH or install yt-dlp on the PATH." });
}

export async function POST(req: Request) {
  let body: { url?: string; title?: string; artist?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const raw = (body.url ?? "").trim();
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
      ["-f", "bestaudio/best", "--no-playlist", "--max-filesize", String(MAX_BYTES), "-o", output, "--no-progress", raw],
      540_000,
    );
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
      title: body.title?.slice(0, 200),
      artist: body.artist?.slice(0, 200),
    });
    return NextResponse.json({ track: result.track, created: result.created, separationQueued: result.separationQueued }, { status: 201 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
