/**
 * Captions — CapCut (#13) for a local-first app: transcripts to SRT/VTT and
 * real transcription through BYOK (Groq whisper-large-v3-turbo — generous free
 * tier — or OpenAI whisper-1). Burn-in via the app's existing ffmpeg core
 * (Waveyard). Owner-side: any whisper.cpp build can be wired the same way.
 */

export type CaptionSegment = { start: number; end: number; text: string }; // seconds

export function formatTimecode(seconds: number, vtt = false): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${vtt ? "." : ","}${pad(ms, 3)}`;
}

export function buildSrt(segments: CaptionSegment[]): string {
  return segments
    .map((segment, index) => `${index + 1}\n${formatTimecode(segment.start)} --> ${formatTimecode(segment.end)}\n${segment.text.trim()}\n`)
    .join("\n");
}

export function buildVtt(segments: CaptionSegment[]): string {
  return (
    "WEBVTT\n\n" +
    segments
      .map((segment, index) => `${index + 1}\n${formatTimecode(segment.start, true)} --> ${formatTimecode(segment.end, true)}\n${segment.text.trim()}\n`)
      .join("\n")
  );
}

export function parseSrt(srt: string): CaptionSegment[] {
  const toSeconds = (timecode: string): number => {
    const m = timecode.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  const segments: CaptionSegment[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const [from, to] = timing.split("-->");
    const text = lines.slice(lines.indexOf(timing) + 1).join(" ");
    if (text.trim()) segments.push({ start: toSeconds(from), end: toSeconds(to), text: text.trim() });
  }
  return segments;
}

/** Distribute plain text into readable caption segments (no timing known). */
export function segmentsFromText(text: string, secondsPerSegment = 3.5): CaptionSegment[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?]) /)
    .filter(Boolean);
  const segments: CaptionSegment[] = [];
  let time = 0;
  for (const sentence of sentences) {
    // Keep on-screen text short: split long sentences on commas.
    const chunks = sentence.length > 84 ? sentence.split(/(?<=,) /) : [sentence];
    for (const chunk of chunks) {
      const duration = Math.max(1.2, Math.min(6, chunk.length / 18));
      segments.push({ start: round2(time), end: round2(time + duration), text: chunk.trim() });
      time += duration;
    }
  }
  return segments;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type TranscribeKeys = { groq?: string; openai?: string };

export type TranscriptionResult =
  | { ok: true; text: string; segments?: CaptionSegment[]; engine: string; via: string }
  | { ok: false; reason: string; tried: string[] };

/**
 * Real transcription via BYOK: Groq (whisper-large-v3-turbo, free tier) first,
 * then OpenAI (whisper-1). Audio never touches disk here; it goes straight to
 * the provider you keyed. Sandbox note: provider endpoints are blocked here —
 * verified owner-side; request shape is unit-tested with an injected fetch.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  opts: { keys?: TranscribeKeys; language?: string; fetchImpl?: typeof fetch } = {},
): Promise<TranscriptionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tried: string[] = [];
  const tiers: { name: string; url: string; model: string; key: string | undefined }[] = [
    { name: "groq", url: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo", key: opts.keys?.groq?.trim() },
    { name: "openai", url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", key: opts.keys?.openai?.trim() },
  ];
  const failures: string[] = [];
  for (const tier of tiers) {
    if (!tier.key) continue;
    tried.push(tier.name);
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: "application/octet-stream" }), filename);
      form.append("model", tier.model);
      if (opts.language) form.append("language", opts.language);
      form.append("response_format", "verbose_json");
      const response = await fetchImpl(tier.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${tier.key}` },
        body: form,
      });
      if (!response.ok) throw new Error(`${tier.name} HTTP ${response.status}`);
      const data = (await response.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
      if (!data.text?.trim()) throw new Error(`${tier.name} returned no text`);
      return {
        ok: true,
        text: data.text,
        segments: data.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })),
        engine: tier.name,
        via: `${tier.name}:${tier.model}`,
      };
    } catch (error) {
      failures.push(`${tier.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: false,
    reason:
      tried.length === 0
        ? "no transcription key set — add a Groq or OpenAI key in KeysBar (Groq has a free tier), or paste a transcript instead"
        : failures.join(" | "),
    tried,
  };
}
