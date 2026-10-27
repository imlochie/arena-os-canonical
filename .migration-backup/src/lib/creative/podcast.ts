/**
 * Podcast — NotebookLM (#5) for a local-first app: any text (notes, lyrics, a
 * transcript, a research answer) becomes a two-host podcast, then real audio
 * through the voice tiers. Follows the podcastfy / open-notebooklm designs
 * (Apache-2.0): LLM writes the dialogue, TTS speaks it — except here every
 * tier is pluggable and honestly labeled.
 */

import { generate, type ChatMsg } from "@/lib/ai";
import { speakText, type SpeakOptions } from "./voice";

export type PodcastLine = { speaker: "A" | "B"; text: string };
export type PodcastScript = { title: string; lines: PodcastLine[]; engine: string; via: string; fallback: boolean };

/** Parse "HOST A:"-style dialogue into lines (robust to common model formats). */
export function parseScript(text: string): { title: string; lines: PodcastLine[] } {
  const lines: PodcastLine[] = [];
  let title = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && (/^#\s+/.test(line) || /^title:/i.test(line))) {
      title = line.replace(/^#\s+/i, "").replace(/^title:\s*/i, "").trim();
      continue;
    }
    const match = line.match(/^(?:host\s*)?([AB])\s*[:.\-]\s*(.+)$/i) ?? line.match(/^speaker\s*([12])\s*[:.\-]\s*(.+)$/i);
    if (match) {
      const speaker = (match[1].toUpperCase() === "A" || match[1] === "1" ? "A" : "B") as "A" | "B";
      lines.push({ speaker, text: match[2].trim() });
    } else if (lines.length > 0 && /^["“(]/.test(line)) {
      // continuation of the previous line
      lines[lines.length - 1].text += ` ${line.replace(/^["“(]|["”)]$/g, "")}`;
    }
  }
  return { title: title || "Podcast", lines };
}

/** Deterministic offline script — the honest Local Engine floor. */
export function fallbackScript(sourceText: string, title?: string): { title: string; lines: PodcastLine[] } {
  const excerpt = sourceText.trim().replace(/\s+/g, " ").slice(0, 600);
  return {
    title: title || "Two minutes on: " + excerpt.slice(0, 60),
    lines: [
      { speaker: "A", text: `Welcome back. Today we are looking at something you gave this app: “${excerpt.slice(0, 160)}…”` },
      { speaker: "B", text: "Right — and the first thing to say is what this actually is. It is your own material, turned into a conversation you can listen to instead of read." },
      { speaker: "A", text: "Which is the whole idea. Commute, gym, chores — the content comes with you." },
      { speaker: "B", text: `The material continues: “${excerpt.slice(160, 320) || "(short source)"}”` },
      { speaker: "A", text: "And when you want the real thing — deeper analysis, better jokes — wire a bigger model in through the Model Hub and this same button gets smarter." },
      { speaker: "B", text: "That is the honest pitch. This episode was written offline by the Local Engine — deterministic, private, and clearly labeled." },
    ],
  };
}

export async function buildPodcastScript(
  sourceText: string,
  opts: { title?: string; style?: string; keys?: Record<string, string>; modelId?: string } = {},
): Promise<PodcastScript> {
  const messages: ChatMsg[] = [
    {
      role: "user",
      content:
        `Turn the following material into a short two-host podcast script (6-10 exchanges).\n` +
        `Style: ${opts.style ?? "warm, curious, concrete — no filler words"}.\n` +
        `Format each line exactly as "HOST A: ..." or "HOST B: ...", first line a "# title".\n\n` +
        `MATERIAL:\n${sourceText.slice(0, 6000)}`,
    },
  ];
  const result = await generate({ modelId: opts.modelId ?? "local-engine", messages, keys: opts.keys as never, temperature: 0.7 });
  const parsed = parseScript(result.text);
  if (parsed.lines.length < 3) {
    const fb = fallbackScript(sourceText, opts.title);
    return { ...fb, engine: result.backend, via: `${result.via ?? "unknown"}+fallback-script`, fallback: true };
  }
  return { ...parsed, title: opts.title || parsed.title, engine: result.backend, via: result.via ?? result.backend, fallback: false };
}

export type PodcastAudio = { ok: true; buffer: Buffer; mime: string; engine: string } | { ok: false; reason: string };

/** Speak the script line-by-line (alternating voices) and join with ffmpeg. */
export async function synthesizePodcast(
  script: { lines: PodcastLine[] },
  opts: SpeakOptions & { voiceB?: string } = {},
): Promise<PodcastAudio> {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "arena-podcast-"));
  try {
    const parts: string[] = [];
    for (const [index, line] of script.lines.entries()) {
      const result = await speakText(line.text, {
        ...opts,
        tmpDir: dir,
        voice: line.speaker === "A" ? opts.voice : opts.voiceB ?? opts.voice,
      });
      if (!result.ok) return { ok: false, reason: `voice tier failed on line ${index + 1}: ${result.reason}` };
      const ext = result.mime.includes("mpeg") ? "mp3" : result.mime.includes("aiff") ? "aiff" : "wav";
      const name = `part-${String(index).padStart(3, "0")}.${ext}`;
      await (await import("node:fs/promises")).writeFile(join(dir, name), result.buffer);
      parts.push(name);
    }
    if (parts.length === 0) return { ok: false, reason: "empty script" };
    // ffmpeg concat — the app already ships ffmpeg (Waveyard core).
    const { execTool } = await import("@/lib/waveyard/ffmpeg");
    const listFile = join(dir, "list.txt");
    await (await import("node:fs/promises")).writeFile(listFile, parts.map((p) => `file '${p}'`).join("\n"));
    const output = join(dir, "podcast.mp3");
    await execTool("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-q:a", "4", output], { timeoutMs: 120_000 });
    const buffer = await readFile(output);
    if (buffer.byteLength < 256) return { ok: false, reason: "ffmpeg produced no audio" };
    return { ok: true, buffer, mime: "audio/mpeg", engine: "ffmpeg-concat" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    void readdir;
  }
}
