"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Creative Suite — the 13-tools mandate made visible: research with citations
 * (Perplexity), decks (Gamma), podcast + voices (NotebookLM/ElevenLabs),
 * captions (CapCut). Video (Veo/Kling) lives in Visual Studio, music/stems
 * (Suno + more) in Waveyard, and every brain in the Model Hub. Every result
 * here shows its real engine (`via`) — nothing is faked.
 */

type Deck = { title: string; subtitle: string; slides: { title: string; bullets: string[] }[]; engine: string; via: string; fallback: boolean };
type Research = { answer: string; sources: { id: number; title: string; snippet: string; origin: string; url?: string }[]; backend: string; via: string; note?: string };
type Script = { title: string; lines: { speaker: "A" | "B"; text: string }[]; engine: string; via: string; fallback: boolean };

const keys = () => ({
  elevenlabs: localStorage.getItem("af_key_elevenlabs") || undefined,
  groq: localStorage.getItem("af_key_groq") || undefined,
  openai: localStorage.getItem("af_key_openai") || undefined,
  openrouter: localStorage.getItem("af_key_openrouter") || undefined,
});

function Card({ title, emoji, blurb, children }: { title: string; emoji: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold text-white">
        <span aria-hidden>{emoji}</span> {title}
      </h2>
      <p className="mt-1 mb-4 text-xs text-slate-400">{blurb}</p>
      {children}
    </section>
  );
}

const input =
  "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none";
const button =
  "rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50";

function download(name: string, data: string | Blob, mime = "text/plain") {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CreativeSuitePage() {
  // ---- research ----
  const [query, setQuery] = useState("");
  const [research, setResearch] = useState<Research | null>(null);
  const [researching, setResearching] = useState(false);
  // ---- deck ----
  const [prompt, setPrompt] = useState("");
  const [deck, setDeck] = useState<(Deck & { html?: string; pptxBase64?: string }) | null>(null);
  const [decking, setDecking] = useState(false);
  const [slide, setSlide] = useState(0);
  // ---- podcast ----
  const [source, setSource] = useState("");
  const [script, setScript] = useState<Script | null>(null);
  const [audioReason, setAudioReason] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [casting, setCasting] = useState(false);
  // ---- voice ----
  const [voiceText, setVoiceText] = useState("");
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const [engines, setEngines] = useState<{ tier: string; available: boolean; detail: string }[]>([]);
  // ---- captions ----
  const [transcript, setTranscript] = useState("");
  const [srt, setSrt] = useState<string | null>(null);
  const audioFile = useRef<HTMLInputElement>(null);
  const [captionMsg, setCaptionMsg] = useState<string | null>(null);
  // ---- shorts / dub ----
  const [shortsAudio, setShortsAudio] = useState<File | null>(null);
  const [shortsBusy, setShortsBusy] = useState(false);
  const [shortsMsg, setShortsMsg] = useState<string | null>(null);
  const [shortsUrl, setShortsUrl] = useState<string | null>(null);
  const [dubLanguage, setDubLanguage] = useState("");
  const [dubUrl, setDubUrl] = useState<string | null>(null);
  const [dubMsg, setDubMsg] = useState<string | null>(null);

  const fileToBase64 = async (file: File): Promise<string> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  };

  const doShorts = useCallback(async () => {
    if (!shortsAudio || !transcript.trim() || shortsBusy) return;
    setShortsBusy(true);
    setShortsMsg(null);
    setShortsUrl(null);
    try {
      const response = await fetch("/api/creative/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: await fileToBase64(shortsAudio), text: transcript }),
      });
      const data = await response.json();
      if (!response.ok || !data.mp4Base64) {
        setShortsMsg(data.error ?? `HTTP ${response.status}`);
        return;
      }
      const bytes = Uint8Array.from(atob(data.mp4Base64), (c) => c.charCodeAt(0));
      setShortsUrl(URL.createObjectURL(new Blob([bytes], { type: "video/mp4" })));
      setShortsMsg(`${(bytes.byteLength / 1024).toFixed(0)} KB MP4 — waveform + burned-in captions`);
    } catch (error) {
      setShortsMsg(error instanceof Error ? error.message : "shorts failed");
    } finally {
      setShortsBusy(false);
    }
  }, [shortsAudio, transcript, shortsBusy]);

  const doDub = useCallback(async () => {
    if (!shortsAudio || !dubLanguage.trim() || shortsBusy) return;
    setShortsBusy(true);
    setDubMsg(null);
    setDubUrl(null);
    try {
      const response = await fetch("/api/creative/shorts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: await fileToBase64(shortsAudio),
          dub: dubLanguage,
          keys: { groq: keys().groq, openai: keys().openai, elevenlabs: keys().elevenlabs },
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.audioBase64) {
        setDubMsg(data.stages ? `${data.failedAt}: ${data.error}` : (data.error ?? `HTTP ${response.status}`));
        return;
      }
      const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));
      setDubUrl(URL.createObjectURL(new Blob([bytes], { type: data.mime ?? "audio/mpeg" })));
      setDubMsg(`dubbed via ${data.stages?.map((s: { stage: string; ok: boolean }) => `${s.stage}${s.ok ? "✓" : "✗"}`).join(" → ")}`);
    } catch (error) {
      setDubMsg(error instanceof Error ? error.message : "dub failed");
    } finally {
      setShortsBusy(false);
    }
  }, [shortsAudio, dubLanguage, shortsBusy]);

  useEffect(() => {
    fetch(`/api/creative/voice?elevenlabs=${encodeURIComponent(localStorage.getItem("af_key_elevenlabs") ?? "")}`)
      .then((r) => r.json())
      .then((d) => setEngines(d.engines ?? []))
      .catch(() => {});
  }, []);

  const doResearch = useCallback(async () => {
    if (!query.trim()) return;
    setResearching(true);
    setResearch(null);
    try {
      const response = await fetch("/api/creative/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, keys: keys() }),
      });
      setResearch(await response.json());
    } finally {
      setResearching(false);
    }
  }, [query]);

  const doDeck = useCallback(async () => {
    if (!prompt.trim()) return;
    setDecking(true);
    setDeck(null);
    try {
      const response = await fetch("/api/creative/slides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, keys: keys() }),
      });
      setDeck(await response.json());
      setSlide(0);
    } finally {
      setDecking(false);
    }
  }, [prompt]);

  const doPodcast = useCallback(async () => {
    if (!source.trim()) return;
    setCasting(true);
    setScript(null);
    setAudioReason(null);
    setAudioUrl(null);
    try {
      const response = await fetch("/api/creative/podcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: source, synthesize: true, keys: keys() }),
      });
      const data = await response.json();
      setScript(data.script ?? null);
      setAudioReason(data.audioReason ?? null);
      if (data.audio?.base64) {
        const bytes = Uint8Array.from(atob(data.audio.base64), (c) => c.charCodeAt(0));
        setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: data.audio.mime })));
      }
    } finally {
      setCasting(false);
    }
  }, [source]);

  const doVoice = useCallback(async () => {
    if (!voiceText.trim()) return;
    setVoiceErr(null);
    setVoiceUrl(null);
    const response = await fetch("/api/creative/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: voiceText, keys: keys() }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setVoiceErr(error.error ?? "voice failed");
      return;
    }
    setVoiceUrl(URL.createObjectURL(await response.blob()));
  }, [voiceText]);

  const doCaptions = useCallback(
    async (mode: "text" | "audio") => {
      setSrt(null);
      setCaptionMsg(null);
      try {
        let response: Response;
        if (mode === "text") {
          if (!transcript.trim()) return;
          response = await fetch("/api/creative/captions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: transcript }),
          });
        } else {
          const file = audioFile.current?.files?.[0];
          if (!file) return;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const toBase64 = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
          response = await fetch("/api/creative/captions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audioBase64: btoa(toBase64),
              filename: file.name,
              keys: { groq: keys().groq, openai: keys().openai },
            }),
          });
        }
        const data = await response.json();
        if (!response.ok) {
          setCaptionMsg(data.error ?? `HTTP ${response.status}`);
          return;
        }
        setSrt(data.srt);
        setCaptionMsg(`${data.segments ?? "?"} cues · engine: ${data.engine}${data.via ? ` (${data.via})` : ""}`);
      } catch (error) {
        setCaptionMsg(error instanceof Error ? error.message : "captions failed");
      }
    },
    [transcript],
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl font-black text-white">Creative Suite</h1>
      <p className="mt-2 text-sm text-slate-400">
        Thirteen-tool energy, local-first rules: every output below carries its real engine. Video lives in{" "}
        <a className="text-violet-400 underline" href="/studio">Visual Studio</a>, music &amp; stems in{" "}
        <a className="text-violet-400 underline" href="/waveyard">Waveyard</a>, brains in the{" "}
        <a className="text-violet-400 underline" href="/model-hub">Model Hub</a>.
      </p>

      <div className="mt-8 grid gap-6">
        <Card emoji="🔎" title="Research with citations" blurb="Perplexity-style answers grounded in your chats, your archive, and (if configured) SearXNG — sources numbered and checkable.">
          <div className="flex gap-2">
            <input className={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doResearch()} placeholder="Ask anything…" />
            <button className={button} onClick={doResearch} disabled={researching}>{researching ? "…" : "Research"}</button>
          </div>
          {research && (
            <div className="mt-4">
              <div className="whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-sm text-slate-200">{research.answer}</div>
              <p className="mt-2 text-[11px] text-slate-500">engine: {research.via}{research.note ? ` · ${research.note}` : ""}</p>
              {research.sources.length > 0 && (
                <ol className="mt-3 space-y-1 text-xs text-slate-400">
                  {research.sources.map((s) => (
                    <li key={s.id}>
                      [{s.id}] <span className="text-slate-300">{s.title}</span>{" "}
                      {s.url ? <a className="text-violet-400 underline" href={s.url} target="_blank" rel="noreferrer">open</a> : `· ${s.origin}`}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </Card>

        <Card emoji="🖼️" title="Deck from a prompt" blurb="Gamma-style: one prompt → a slide deck. Present in the browser, download an editable .pptx.">
          <div className="flex gap-2">
            <input className={input} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doDeck()} placeholder="e.g. why local-first AI wins" />
            <button className={button} onClick={doDeck} disabled={decking}>{decking ? "…" : "Generate"}</button>
          </div>
          {deck && (
            <div className="mt-4">
              <div className="rounded-xl border border-white/10 bg-gradient-to-br from-indigo-950 to-violet-900/40 p-6">
                <h3 className="text-2xl font-black text-white">{deck.title}</h3>
                <p className="mt-1 text-sm text-indigo-300">{deck.subtitle}</p>
                {deck.slides[slide] && (
                  <div className="mt-4">
                    <h4 className="text-lg font-bold text-violet-200">{deck.slides[slide].title}</h4>
                    <ul className="mt-2 space-y-1 text-sm text-slate-200">
                      {deck.slides[slide].bullets.map((b, i) => <li key={i}>→ {b}</li>)}
                    </ul>
                  </div>
                )}
                <div className="mt-4 flex items-center gap-3 text-xs text-indigo-300">
                  <button className="rounded border border-white/20 px-2 py-1" onClick={() => setSlide(Math.max(0, slide - 1))}>←</button>
                  {slide + 1} / {deck.slides.length}
                  <button className="rounded border border-white/20 px-2 py-1" onClick={() => setSlide(Math.min(deck.slides.length - 1, slide + 1))}>→</button>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button className={button} onClick={() => deck.html && download("deck.html", deck.html, "text/html")}>Download HTML</button>
                <button className={button} onClick={() => {
                  if (!deck.pptxBase64) return;
                  const bytes = Uint8Array.from(atob(deck.pptxBase64), (c) => c.charCodeAt(0));
                  download("deck.pptx", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
                }}>Download .pptx</button>
                <span className="self-center text-[11px] text-slate-500">engine: {deck.via}{deck.fallback ? " (structured fallback)" : ""}</span>
              </div>
            </div>
          )}
        </Card>

        <Card emoji="🎙️" title="Podcast from any text" blurb="NotebookLM-style: paste notes, lyrics or a transcript → a two-host script → real audio (ElevenLabs key, free Edge voices, or OS voices).">
          <textarea className={`${input} h-24`} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Paste anything — meeting notes, song lyrics, a chapter…" />
          <button className={`${button} mt-2`} onClick={doPodcast} disabled={casting}>{casting ? "…" : "Make episode"}</button>
          {script && (
            <div className="mt-4">
              <h3 className="font-bold text-white">{script.title}</h3>
              <div className="mt-2 max-h-56 space-y-1 overflow-y-auto text-sm">
                {script.lines.map((line, i) => (
                  <p key={i} className={line.speaker === "A" ? "text-slate-200" : "text-violet-300"}>
                    <span className="font-bold">{line.speaker}:</span> {line.text}
                  </p>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">script engine: {script.via}{script.fallback ? " (offline fallback script)" : ""}</p>
              {audioUrl && <audio className="mt-2 w-full" controls src={audioUrl} />}
              {audioReason && <p className="mt-2 rounded-lg bg-amber-950/40 p-2 text-xs text-amber-300">No audio this time — {audioReason}</p>}
            </div>
          )}
        </Card>

        <Card emoji="🗣️" title="Voice" blurb="ElevenLabs-style TTS. Tiers: your ElevenLabs key → free Microsoft Edge voices → your OS voices (macOS say / Windows SAPI / espeak).">
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
            {engines.map((e) => (
              <span key={e.tier} className={`rounded-full border px-2 py-0.5 ${e.available ? "border-emerald-500/40 text-emerald-300" : "border-white/10 text-slate-500"}`}>
                {e.tier}: {e.detail}
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input className={input} value={voiceText} onChange={(e) => setVoiceText(e.target.value)} placeholder="Text to speak…" />
            <button className={button} onClick={doVoice}>Speak</button>
          </div>
          {voiceUrl && <audio className="mt-3 w-full" controls src={voiceUrl} />}
          {voiceErr && <p className="mt-2 rounded-lg bg-amber-950/40 p-2 text-xs text-amber-300">{voiceErr}</p>}
        </Card>

        <Card emoji="💬" title="Captions" blurb="CapCut-style: paste a transcript (or send audio to Groq/OpenAI whisper with your key) → timed .srt/.vtt. Burn-in lands in the Cut Lab next.">
          <textarea className={`${input} h-20`} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Paste a transcript…" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={button} onClick={() => doCaptions("text")}>Transcript → SRT</button>
            <input ref={audioFile} type="file" accept="audio/*,video/*" className="hidden" onChange={() => doCaptions("audio")} />
            <button className={button} onClick={() => audioFile.current?.click()}>Audio → transcribe</button>
          </div>
          {captionMsg && <p className="mt-2 text-xs text-slate-400">{captionMsg}</p>}
          {srt && (
            <div className="mt-3 flex gap-2">
              <button className={button} onClick={() => download("captions.srt", srt)}>Download .srt</button>
              <button className={button} onClick={() => download("captions.vtt", srt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2"), "text/vtt")}>Download .vtt</button>
            </div>
          )}
        </Card>

        <Card emoji="🎬" title="Shorts" blurb="CapCut-style output: audio + the transcript above → an MP4 with the waveform visualized and the subtitles burned in. Or dub the audio into another language (needs a Groq/OpenAI key for transcription).">
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${button} cursor-pointer`}>
              {shortsAudio ? shortsAudio.name.slice(0, 30) : "Choose audio…"}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => setShortsAudio(e.target.files?.[0] ?? null)}
              />
            </label>
            <button className={button} onClick={doShorts} disabled={!shortsAudio || !transcript.trim() || shortsBusy}>
              {shortsBusy ? "Rendering…" : "Render captioned MP4"}
            </button>
            <input
              className="w-32 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
              value={dubLanguage}
              onChange={(e) => setDubLanguage(e.target.value)}
              placeholder="dub: French…"
            />
            <button className={button} onClick={doDub} disabled={!shortsAudio || !dubLanguage.trim() || shortsBusy}>
              Dub audio
            </button>
          </div>
          {shortsMsg && <p className="mt-2 text-xs text-slate-400">{shortsMsg}</p>}
          {shortsUrl && (
            <video className="mt-3 w-full rounded-xl border border-white/10" controls src={shortsUrl} />
          )}
          {dubMsg && <p className="mt-2 text-xs text-slate-400">{dubMsg}</p>}
          {dubUrl && <audio className="mt-2 w-full" controls src={dubUrl} />}
        </Card>
      </div>
    </main>
  );
}
