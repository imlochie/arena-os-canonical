"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import { loadKeys } from "./KeysBar";
import PrivacyControls from "./PrivacyControls";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  description: string;
}
interface Assistant {
  id: string;
  name: string;
  avatar: string;
  description: string;
  baseModel: string;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
  via?: string;
}

export default function DirectChat() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [chats, setChats] = useState<any[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("openai");
  const [assistantId, setAssistantId] = useState<string>("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((j) => setModels(j.models ?? [])).catch(() => {});
    fetch("/api/assistants").then((r) => r.json()).then((j) => setAssistants(j.assistants ?? [])).catch(() => {});
    refreshChats();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function refreshChats() {
    try {
      const r = await fetch("/api/chats");
      const j = await r.json();
      setChats(j.chats ?? []);
    } catch {}
  }

  async function openChat(id: string) {
    try {
      const r = await fetch(`/api/chats/${id}`);
      const j = await r.json();
      setChatId(id);
      setMsgs((j.messages ?? []).map((m: any) => ({ role: m.role, content: m.content })));
      if (j.chat) {
        setModelId(j.chat.modelId ?? "openai");
        setAssistantId(j.chat.assistantId ?? "");
      }
    } catch {}
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const flags = privacyFlags();
    const withUser = [...msgs, { role: "user" as const, content: text }];
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    try {
      // Ephemeral: stateless — transcript travels with the request, nothing stored.
      const payload: any = flags.ephemeral
        ? {
            history: withUser.slice(-20).map((m) => ({ role: m.role, content: m.content })),
            modelId,
            assistantId: assistantId || undefined,
            keys: loadKeys(),
            ...flags,
          }
        : chatId
          ? { mode: "message", chatId, message: text, keys: loadKeys(), ...flags }
          : {
              mode: "create",
              message: text,
              modelId,
              assistantId: assistantId || undefined,
              keys: loadKeys(),
              ...flags,
            };
      const r = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      if (j.chat) {
        setChatId(j.chat.id);
        refreshChats();
      }
      setMsgs((m) => [...m, { role: "assistant", content: j.reply, via: j.via }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "⚠️ That request failed. Try again — the offline fallback will kick in if the free cloud is busy." }]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteChat(id: string) {
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (chatId === id) {
      setChatId(null);
      setMsgs([]);
    }
    refreshChats();
  }

  const newChat = () => {
    setChatId(null);
    setMsgs([]);
  };

  const activeAssistant = assistants.find((a) => a.id === assistantId);
  const privacy = usePrivacySettings();

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <aside className="glass h-fit rounded-2xl p-4 lg:sticky lg:top-20">
        <button onClick={newChat} className="btn-arena w-full rounded-xl px-4 py-2.5 text-sm font-extrabold text-white">
          ＋ New chat
        </button>

        <p className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">Model</p>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
          ))}
        </select>

        <p className="mb-1.5 mt-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Persona (optional)</p>
        <select
          value={assistantId}
          onChange={(e) => setAssistantId(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none"
        >
          <option value="">— Raw model, no persona —</option>
          {assistants.map((a) => (
            <option key={a.id} value={a.id}>{a.avatar} {a.name}</option>
          ))}
        </select>
        {activeAssistant && (
          <p className="mt-1.5 text-[11px] text-slate-400">Persona overrides model with its tuned brain.</p>
        )}

        <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">History</p>
        <div className="scroll-thin max-h-64 space-y-1.5 overflow-y-auto">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-semibold ring-1 transition ${
                chatId === c.id
                  ? "bg-violet-600/20 text-white ring-violet-500/40"
                  : "bg-white/[0.03] text-slate-300 ring-white/5 hover:bg-white/10"
              }`}
            >
              <button onClick={() => openChat(c.id)} className="min-w-0 flex-1 truncate text-left">
                {c.title}
              </button>
              <button
                onClick={() => deleteChat(c.id)}
                className="hidden rounded px-1 text-slate-500 hover:text-red-300 group-hover:block"
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
          {chats.length === 0 && <p className="text-xs text-slate-500">No chats yet.</p>}
        </div>
      </aside>

      <div className="glass flex min-h-[560px] flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2.5 border-b border-white/10 bg-white/[0.02] px-4 py-3">
          <span className="text-xl">{activeAssistant?.avatar ?? models.find((m) => m.id === modelId)?.emoji ?? "🤖"}</span>
          <div>
            <p className="text-sm font-extrabold text-white">
              {activeAssistant ? activeAssistant.name : models.find((m) => m.id === modelId)?.name ?? "Chat"}
            </p>
            <p className="text-[11px] text-slate-400">
              {privacy.ephemeral
                ? "👻 ephemeral — nothing saved"
                : privacy.localMode || !privacy.online
                  ? "🔒 local · saved to your history"
                  : "free tier · saved to your history"}
            </p>
          </div>
          <div className="ml-auto">
            <PrivacyControls compact />
          </div>
        </div>

        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
          {msgs.length === 0 && (
            <div className="grid h-full min-h-[300px] place-items-center">
              <div className="text-center">
                <p className="text-4xl">💬</p>
                <p className="mt-2 text-sm font-extrabold text-white">Start a direct conversation</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">
                  Unlike the arena, here you choose the brain. Pick a model or one of your custom assistants,
                  then chat — everything is stored and free.
                </p>
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  m.role === "user"
                    ? "rounded-br-md bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-[0_8px_24px_rgba(124,58,237,0.35)]"
                    : "rounded-bl-md border border-white/10 bg-white/[0.04]"
                }`}
              >
                {m.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                ) : (
                  <>
                    <Markdown text={m.content} />
                    {m.via && <p className="mt-2 text-[10px] text-slate-500">via {m.via} · free</p>}
                  </>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.04] px-4 py-3">
                <span className="typing-dot h-2 w-2 rounded-full bg-violet-400" />
                <span className="typing-dot h-2 w-2 rounded-full bg-violet-400" />
                <span className="typing-dot h-2 w-2 rounded-full bg-cyan-400" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-white/10 p-3">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Message… (Enter to send)"
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
            />
            <button onClick={send} disabled={busy || !input.trim()} className="btn-arena rounded-xl px-5 py-2.5 text-sm font-extrabold text-white">
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
