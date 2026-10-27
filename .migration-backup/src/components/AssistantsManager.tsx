"use client";

import { useEffect, useState } from "react";

interface Assistant {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  baseModel: string;
  temperature: number;
  avatar: string;
  createdAt?: string;
}

const AVATARS = ["🤖", "💫", "🧠", "🎨", "🪲", "🦊", "🐙", "⚡", "🌙", "🔥", "💎", "🎭", "📚", "🛡️", "🚀", "🧬"];

export default function AssistantsManager() {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Assistant | null>(null);
  const [form, setForm] = useState({ name: "", description: "", systemPrompt: "", baseModel: "openai", temperature: 0.7, avatar: "🤖" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      fetch("/api/assistants").then((r) => r.json()),
      fetch("/api/models").then((r) => r.json()),
    ])
      .then(([a, m]) => {
        setAssistants(a.assistants ?? []);
        setModels(m.models ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const resetForm = () => {
    setEditing(null);
    setForm({ name: "", description: "", systemPrompt: "", baseModel: "openai", temperature: 0.7, avatar: "🤖" });
  };

  const startEdit = (a: Assistant) => {
    setEditing(a);
    setForm({
      name: a.name,
      description: a.description,
      systemPrompt: a.systemPrompt,
      baseModel: a.baseModel,
      temperature: a.temperature,
      avatar: a.avatar,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  async function save() {
    if (!form.name.trim() || !form.systemPrompt.trim() || saving) return;
    setSaving(true);
    try {
      if (editing) {
        const r = await fetch(`/api/assistants/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const j = await r.json();
        setAssistants((list) => list.map((a) => (a.id === editing.id ? j.assistant : a)));
      } else {
        const r = await fetch("/api/assistants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const j = await r.json();
        setAssistants((list) => [j.assistant, ...list]);
      }
      resetForm();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this assistant?")) return;
    await fetch(`/api/assistants/${id}`, { method: "DELETE" });
    setAssistants((list) => list.filter((a) => a.id !== id));
  }

  async function test(a: Assistant) {
    setTesting(a.id);
    try {
      const keys = {
        openrouter: localStorage.getItem("af_key_openrouter") || undefined,
        groq: localStorage.getItem("af_key_groq") || undefined,
      };
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: a.baseModel,
          system: a.systemPrompt,
          temperature: a.temperature,
          messages: [{ role: "user", content: "Introduce yourself in 2 sentences and say what you're best at." }],
          keys,
        }),
      });
      const j = await r.json();
      setTestResult((t) => ({ ...t, [a.id]: j.text ?? "No response" }));
    } catch {
      setTestResult((t) => ({ ...t, [a.id]: "Test failed — try again." }));
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <p className="text-slate-400">Loading assistants…</p>;

  return (
    <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
      {/* Form */}
      <div className="glass h-fit rounded-2xl p-5 lg:sticky lg:top-20">
        <h2 className="text-base font-extrabold text-white">{editing ? "✏️ Edit assistant" : "🧬 New assistant"}</h2>
        <p className="mt-1 text-xs text-slate-400">
          Personal AIs = a system prompt + a free brain + your taste. They work in Direct Chat instantly.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Avatar</p>
            <div className="flex flex-wrap gap-1.5">
              {AVATARS.map((e) => (
                <button
                  key={e}
                  onClick={() => setForm({ ...form, avatar: e })}
                  className={`grid h-9 w-9 place-items-center rounded-lg text-lg transition ${
                    form.avatar === e ? "bg-violet-600 ring-2 ring-violet-300" : "bg-white/5 hover:bg-white/10"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Study Coach"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">One-line description</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What does it do for you?"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">System prompt (its personality)</span>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              rows={5}
              placeholder="You are a patient study coach. Quiz me, use spaced repetition, never give answers directly…"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Brain</span>
              <select
                value={form.baseModel}
                onChange={(e) => setForm({ ...form, baseModel: e.target.value })}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Temp: {form.temperature.toFixed(1)}
              </span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={form.temperature}
                onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
                className="mt-2.5 w-full accent-violet-500"
              />
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={saving || !form.name.trim() || !form.systemPrompt.trim()} className="btn-arena flex-1 rounded-xl px-4 py-2.5 text-sm font-extrabold text-white">
              {saving ? "Saving…" : editing ? "Save changes" : "Create assistant"}
            </button>
            {editing && (
              <button onClick={resetForm} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10">
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* List */}
      <div className="grid content-start gap-4 sm:grid-cols-2">
        {assistants.map((a) => (
          <div key={a.id} className="glass card-hover flex flex-col rounded-2xl p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-600/40 to-cyan-500/20 text-2xl ring-1 ring-white/10">
                {a.avatar}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[15px] font-extrabold text-white">{a.name}</h3>
                <p className="line-clamp-2 text-xs text-slate-400">{a.description || "No description"}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-bold">
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-slate-300 ring-1 ring-white/10">
                🧠 {models.find((m) => m.id === a.baseModel)?.name ?? a.baseModel}
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-slate-300 ring-1 ring-white/10">
                🌡️ {Number(a.temperature).toFixed(1)}
              </span>
            </div>
            <details className="mt-3 rounded-lg bg-black/30 p-2.5 ring-1 ring-white/5">
              <summary className="cursor-pointer text-xs font-bold text-slate-300">System prompt</summary>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{a.systemPrompt}</p>
            </details>
            {testResult[a.id] && (
              <p className="mt-2 whitespace-pre-wrap rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-2.5 text-xs text-emerald-100/90">
                {testResult[a.id]}
              </p>
            )}
            <div className="mt-3 flex gap-1.5 pt-1">
              <button onClick={() => test(a)} disabled={testing === a.id} className="flex-1 rounded-lg bg-emerald-600/80 px-3 py-2 text-xs font-extrabold text-white hover:bg-emerald-600 disabled:opacity-60">
                {testing === a.id ? "…" : "⚡ Test"}
              </button>
              <a href="/chat" className="flex-1 rounded-lg bg-violet-600/80 px-3 py-2 text-center text-xs font-extrabold text-white hover:bg-violet-600">
                💬 Chat
              </a>
              <button onClick={() => startEdit(a)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-extrabold text-white hover:bg-white/10">
                ✏️
              </button>
              <button onClick={() => remove(a.id)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-extrabold text-red-300 hover:bg-red-500/20">
                🗑️
              </button>
            </div>
          </div>
        ))}
        {assistants.length === 0 && (
          <p className="text-sm text-slate-500">No assistants yet — create your first one.</p>
        )}
      </div>
    </div>
  );
}
