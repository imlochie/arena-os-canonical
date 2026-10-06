"use client";

import { useEffect, useState } from "react";
import { FREE_MODELS, LOCAL_ENGINE_ID } from "@/lib/models";
import { LEVEL_LABELS, LEVEL_NUMBER, type RuntimeLevel } from "@/lib/runtime";
import { loadEngine, generateChat, checkWebGPU } from "@/lib/webllm";
import { loadKeys } from "@/components/KeysBar";

/**
 * Arena Benchmark — run the SAME prompt through genuinely different execution
 * paths and compare what actually ran. This is the proof that Arena has
 * multiple levels: every result reports its real runtime, latency, and
 * fallback status — nothing is staged.
 */

interface BenchRow {
  key: string;
  label: string;
  level: RuntimeLevel;
  backend: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  firstTokenMs?: number | null;
  text: string;
  fallback: boolean;
  fallbackReason?: string | null;
  note?: string | null;
  error?: string;
  ranAt: string;
}

interface TargetDef {
  key: string;
  label: string;
  modelId: string;
  level: RuntimeLevel;
  backend: string;
  hint: string;
  clientSide?: "webllm";
}

const TARGETS: TargetDef[] = [
  { key: "local", label: "Arena Local Engine", modelId: LOCAL_ENGINE_ID, level: "arena-local", backend: "arena-local-engine", hint: "always available — deterministic, not an LLM" },
  { key: "webllm", label: "Qwen Coder 1.5B · WebLLM", modelId: "webllm-qwen-coder-1.5b", level: "on-device", backend: "webllm", hint: "browser WebGPU — download required", clientSide: "webllm" },
  { key: "turbo", label: "Qwen 7B · TurboAgent", modelId: "turboagent-7b", level: "on-device", backend: "turboagent", hint: "your local server — needs configuration" },
  { key: "remote", label: "Remote Model", modelId: "openai", level: "remote", backend: "pollinations", hint: "network required — free/keyless" },
];

const REMOTE_MODELS = FREE_MODELS.filter((m) => m.level === "remote" && m.kind === "text");

export default function BenchmarkPage() {
  const [prompt, setPrompt] = useState("Explain what a Bloom filter is, in two sentences.");
  const [remoteModel, setRemoteModel] = useState("openai");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ local: true, webllm: true, turbo: true, remote: true });
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [webgpuOk, setWebgpuOk] = useState<boolean | null>(null);

  useEffect(() => {
    checkWebGPU().then((r) => setWebgpuOk(r.ok));
  }, []);

  async function runServer(modelId: string, keys?: Record<string, string | undefined>): Promise<Partial<BenchRow>> {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, messages: [{ role: "user", content: prompt }], keys }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "request failed");
    const rt = j.runtime ?? {};
    return {
      backend: rt.backend ?? j.backend,
      provider: rt.provider ?? "",
      modelId: rt.modelId ?? j.modelId,
      latencyMs: rt.latencyMs ?? rt.ms ?? j.ms ?? 0,
      firstTokenMs: rt.firstTokenMs ?? null,
      text: j.text ?? "",
      fallback: rt.fallback ?? j.fallback ?? false,
      fallbackReason: rt.fallbackReason ?? null,
      note: rt.note ?? null,
    };
  }

  async function runWebLLM(modelId: string): Promise<Partial<BenchRow>> {
    const model = FREE_MODELS.find((m) => m.id === modelId);
    const mlcId = (model?.pollinationsId ?? "").replace("__webllm__:", "");
    if (!mlcId) throw new Error("not a WebLLM model");
    if (webgpuOk === false) throw new Error("WebGPU unavailable in this browser");
    await loadEngine(mlcId);
    const t0 = Date.now();
    const text = await generateChat([{ role: "user", content: prompt }]);
    return {
      backend: "webllm",
      provider: "webllm",
      modelId,
      latencyMs: Date.now() - t0,
      text,
      fallback: false,
      note: "executed in this browser via WebGPU",
    };
  }

  async function run() {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setRows([]);
    const keys = loadKeys() as Record<string, string | undefined>;
    const selected = TARGETS.filter((t) => enabled[t.key]);
    const results: BenchRow[] = [];

    await Promise.all(
      selected.map(async (t) => {
        const base: BenchRow = {
          key: t.key,
          label: t.key === "remote" ? `${FREE_MODELS.find((m) => m.id === remoteModel)?.name ?? remoteModel} · Remote` : t.label,
          level: t.level,
          backend: t.backend,
          provider: t.backend,
          modelId: t.modelId,
          latencyMs: 0,
          text: "",
          fallback: false,
          ranAt: new Date().toISOString(),
        };
        try {
          let partial: Partial<BenchRow>;
          if (t.clientSide === "webllm") {
            partial = await runWebLLM(t.modelId);
          } else {
            partial = await runServer(t.key === "remote" ? remoteModel : t.modelId, keys);
          }
          const row = { ...base, ...partial, ranAt: new Date().toISOString() };
          setRows((r) => [...r, row]);
          results.push(row);
        } catch (e: any) {
          setRows((r) => [
            ...r,
            { ...base, error: e?.message ?? "execution failed", ranAt: new Date().toISOString() },
          ]);
        }
      }),
    );
    setRunning(false);
  }

  const levelTone = (l: RuntimeLevel) =>
    l === "arena-local" ? "text-emerald-300" : l === "on-device" ? "text-sky-300" : "text-amber-300";

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-black text-white">⏱ Arena Benchmark</h1>
      <p className="mt-2 text-sm text-slate-400">
        One prompt, genuinely different execution paths. Every row reports what <em>actually</em> ran — level,
        backend, provider, measured latency, and fallback status. Failed paths are shown as failures, never
        substituted.
      </p>

      <div className="glass mt-6 rounded-2xl p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Execution targets</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {TARGETS.map((t) => (
            <label
              key={t.key}
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 ${
                enabled[t.key] ? "border-violet-400/40 bg-violet-500/10" : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <input
                type="checkbox"
                checked={!!enabled[t.key]}
                onChange={(e) => setEnabled((s) => ({ ...s, [t.key]: e.target.checked }))}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className={`block text-xs font-black ${levelTone(t.level)}`}>
                  LEVEL {LEVEL_NUMBER[t.level]} · {LEVEL_LABELS[t.level]}
                </span>
                <span className="block text-sm font-bold text-white">{t.label}</span>
                <span className="block text-[11px] text-slate-500">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {enabled.remote && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Remote model:</span>
            <select
              value={remoteModel}
              onChange={(e) => setRemoteModel(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none"
            >
              {REMOTE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
              ))}
            </select>
          </div>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="mt-3 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          placeholder="The prompt every target will answer…"
        />
        <button
          onClick={run}
          disabled={running || !prompt.trim()}
          className="btn-arena mt-3 rounded-xl px-5 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
        >
          {running ? "Running…" : "▶ Run benchmark"}
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {rows.map((r) => (
          <div
            key={r.key + r.ranAt}
            className={`glass rounded-2xl p-4 ${r.error ? "border-red-400/30" : ""}`}
            data-testid="benchmark-row"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className={`text-[10px] font-black uppercase tracking-[0.16em] ${levelTone(r.level)}`}>
                  LEVEL {LEVEL_NUMBER[r.level]} · {LEVEL_LABELS[r.level]}
                </p>
                <p className="text-sm font-extrabold text-white">{r.error ? r.label : r.modelId}</p>
                <p className="text-[11px] text-slate-500">
                  backend {r.backend} · provider {r.provider || r.backend}
                </p>
              </div>
              <div className="text-right">
                {r.error ? (
                  <span className="rounded-full bg-red-400/15 px-2.5 py-0.5 text-[11px] font-bold text-red-300 ring-1 ring-red-400/30">
                    DID NOT RUN
                  </span>
                ) : r.fallback ? (
                  <span className="rounded-full bg-amber-400/15 px-2.5 py-0.5 text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/30">
                    FALLBACK
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
                    EXECUTED
                  </span>
                )}
                {!r.error && <p className="mt-1 text-[11px] text-slate-400">{r.latencyMs}ms measured</p>}
                {!r.error && r.firstTokenMs ? <p className="text-[11px] text-slate-500">first token {r.firstTokenMs}ms</p> : null}
              </div>
            </div>
            {r.error ? (
              <p className="mt-2 rounded-lg border border-red-400/20 bg-red-400/[0.07] p-2 text-xs text-red-200">
                ⚠️ {r.error} — this path was not silently substituted. Configure it on <a href="/runtime" className="underline">/runtime</a>.
              </p>
            ) : (
              <>
                {r.fallback && (
                  <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] p-2 text-xs text-amber-200">
                    ⚠️ Fallback: Arena Local Engine — {r.fallbackReason ?? r.note ?? "requested runtime unavailable"}.
                  </p>
                )}
                <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-200 scroll-thin">
                  {r.text.slice(0, 3000)}
                </p>
                {r.note && !r.fallback && <p className="mt-1 text-[11px] text-slate-500">{r.note}</p>}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
