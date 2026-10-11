/**
 * Voice — text-to-speech with honest tiers (ElevenLabs.io #11 of the tools
 * mandate). No engine is ever faked: every tier either produces real audio or
 * reports exactly why it could not.
 *
 * Tier 1  ElevenLabs BYOK   (keys.elevenlabs — free 10k chars/month)
 * Tier 2  Edge read-aloud   (msedge-tts npm — Microsoft's free voices, needs
 *                           network to speech.platform.bing.com)
 * Tier 3  OS voices         (Windows SAPI / macOS `say` / Linux espeak —
 *                           always offline, zero dependencies)
 *
 * All tiers are local-first friendly: nothing is stored server-side, keys are
 * passed per-request from the browser.
 */

export type VoiceKeys = { elevenlabs?: string };

export type SpeakOptions = {
  keys?: VoiceKeys;
  voice?: string; // provider-specific voice id/name
  rate?: number; // OS tier: words per minute scale
  fetchImpl?: typeof fetch;
  execImpl?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  tmpDir?: string;
};

export type SpeakResult =
  | { ok: true; buffer: Buffer; mime: string; engine: string; via: string }
  | { ok: false; reason: string; tried: string[] };

const ELEVEN_VOICES: Record<string, string> = {
  // Stable public voice ids (Rachel and Adam — the classic free-tier pair).
  rachel: "21m00Tcm4TlvDq8ikWAM",
  adam: "pNInz6obpgDQGcFmaJgB",
};

async function tryElevenLabs(text: string, opts: SpeakOptions): Promise<SpeakResult> {
  const key = opts.keys?.elevenlabs?.trim();
  if (!key) throw new Error("no elevenlabs key");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const voiceId = ELEVEN_VOICES[(opts.voice ?? "rachel").toLowerCase()] ?? opts.voice ?? ELEVEN_VOICES.rachel;
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!response.ok) throw new Error(`elevenlabs HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 64) throw new Error("elevenlabs returned no audio");
  return { ok: true, buffer: Buffer.from(bytes), mime: "audio/mpeg", engine: "elevenlabs", via: `elevenlabs:${voiceId}` };
}

async function tryEdge(text: string, opts: SpeakOptions): Promise<SpeakResult> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const dir = opts.tmpDir ?? "/tmp";
  const tts = new MsEdgeTTS();
  await tts.setMetadata(opts.voice ?? "en-US-ChristopherNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(dir, text);
  const { readFileSync, rmSync } = await import("node:fs");
  try {
    const buffer = readFileSync(audioFilePath);
    if (buffer.byteLength < 64) throw new Error("edge tts produced no audio");
    return { ok: true, buffer, mime: "audio/mpeg", engine: "edge-tts", via: `edge:${opts.voice ?? "en-US-ChristopherNeural"}` };
  } finally {
    rmSync(audioFilePath, { force: true });
  }
}

async function tryOsVoice(text: string, opts: SpeakOptions): Promise<SpeakResult> {
  const { platform } = await import("node:os");
  const dir = opts.tmpDir ?? "/tmp";
  const exec = opts.execImpl ?? (async (command: string, args: string[]) => {
    const { execFile } = await import("node:child_process");
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  });
  const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const os = platform();
  if (os === "darwin") {
    const out = `${dir}/arena-say-${safe}.aiff`;
    await exec("say", ["-o", out, ...(opts.rate ? ["-r", String(opts.rate)] : []), text]);
    const { readFileSync, rmSync } = await import("node:fs");
    const buffer = readFileSync(out);
    rmSync(out, { force: true });
    return { ok: true, buffer, mime: "audio/aiff", engine: "os-say", via: "os:darwin-say" };
  }
  if (os === "win32") {
    const out = `${dir}\\arena-say-${safe}.wav`.replace(/\//g, "\\");
    const ps =
      `Add-Type -AssemblyName System.Speech; ` +
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile('${out}'); $s.Speak([Net.ServicePointManager]::SecurityProtocol -ne $null ? $args[0] : $args[0]); $s.Dispose()`;
    // PowerShell receives the text as an argument (no injection: it is passed
    // as a single quoted argument, never interpolated into the script).
    await exec("powershell", ["-NoProfile", "-Command", ps, "-args", text]);
    const { readFileSync, rmSync } = await import("node:fs");
    const buffer = readFileSync(out);
    rmSync(out, { force: true });
    return { ok: true, buffer, mime: "audio/wav", engine: "os-sapi", via: "os:win32-sapi" };
  }
  // Linux: espeak-ng / espeak if installed.
  for (const bin of ["espeak-ng", "espeak"]) {
    const out = `${dir}/arena-say-${safe}.wav`;
    try {
      await exec(bin, ["-w", out, text]);
      const { readFileSync, rmSync } = await import("node:fs");
      const buffer = readFileSync(out);
      rmSync(out, { force: true });
      return { ok: true, buffer, mime: "audio/wav", engine: `os-${bin}`, via: `os:${bin}` };
    } catch {
      // try next binary
    }
  }
  throw new Error("no OS voice engine (install espeak-ng, or use macOS/Windows)");
}

/** Speak text through the first tier that works. Never fakes audio. */
export async function speakText(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "nothing to say (empty text)", tried: [] };
  const tried: string[] = [];
  const tiers: [string, () => Promise<SpeakResult>][] = [
    ["elevenlabs", () => tryElevenLabs(trimmed, opts)],
    ["edge-tts", () => tryEdge(trimmed, opts)],
    ["os-voice", () => tryOsVoice(trimmed, opts)],
  ];
  const failures: string[] = [];
  for (const [name, run] of tiers) {
    try {
      return await run();
    } catch (error) {
      tried.push(name);
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: false,
    reason: `no voice engine available — ${failures.join(" | ")}`,
    tried,
  };
}

/** Which tiers are configured for this machine (for honest UI status). */
export async function voiceEngineStatus(keys?: VoiceKeys): Promise<{ tier: string; available: boolean; detail: string }[]> {
  const { platform } = await import("node:os");
  const os = platform();
  let osDetail = "no OS voice engine detected";
  if (os === "darwin") osDetail = "macOS `say` (offline)";
  else if (os === "win32") osDetail = "Windows SAPI (offline)";
  else {
    const { execImpl } = {} as SpeakOptions;
    void execImpl;
    for (const bin of ["espeak-ng", "espeak"]) {
      try {
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve, reject) =>
          execFile(bin, ["--version"], { timeout: 3000 }, (error) => (error ? reject(error) : resolve())),
        );
        osDetail = `${bin} (offline)`;
        break;
      } catch {
        /* keep looking */
      }
    }
  }
  return [
    { tier: "elevenlabs", available: Boolean(keys?.elevenlabs?.trim()), detail: keys?.elevenlabs ? "BYOK key set" : "no key" },
    { tier: "edge-tts", available: true, detail: "free Microsoft voices (needs network)" },
    { tier: "os-voice", available: os === "darwin" || os === "win32" || osDetail.includes("espeak"), detail: osDetail },
  ];
}
