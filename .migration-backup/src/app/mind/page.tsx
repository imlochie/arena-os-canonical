"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The Mind — the mymind dupe. One private wall: paste anything (thought,
 * link, quote), drop an image, and the app auto-tags + summarizes it. No
 * folders: search, tag chips, smart spaces, favorites, serendipity. Every
 * card shows which engine tagged it — the local floor says so honestly.
 */

type Item = {
  id: string;
  name: string;
  kind: string;
  content: string | null;
  description: string;
  tags: string[];
  color: string | null;
  favorite: boolean;
  engine: string;
  path: string | null;
  createdAt: string;
};

type Space = { name: string; tags: string[]; kinds: string[]; q?: string };

const KIND_EMOJI: Record<string, string> = { note: "📝", link: "🔗", quote: "❝", image: "🖼️", doc: "📄", audio: "🎧", video: "🎬", other: "📦" };
const KINDS = ["note", "link", "quote", "image", "doc", "audio", "video"];

const keys = () => ({
  groq: localStorage.getItem("af_key_groq") || undefined,
  openai: localStorage.getItem("af_key_openai") || undefined,
  openrouter: localStorage.getItem("af_key_openrouter") || undefined,
  mistral: localStorage.getItem("af_key_mistral") || undefined,
});

function smartSpaceMatches(item: Item, space: Space): boolean {
  if (space.kinds.length > 0 && !space.kinds.includes(String(item.kind))) return false;
  if (space.tags.length > 0 && !space.tags.every((tag) => item.tags.includes(tag.toLowerCase()))) return false;
  if (space.q?.trim()) {
    const term = space.q.trim().toLowerCase();
    if (!`${item.name} ${item.description} ${item.tags.join(" ")} ${item.content ?? ""}`.toLowerCase().includes(term)) return false;
  }
  return true;
}

export default function MindPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpace, setActiveSpace] = useState<string>("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setSpaces(JSON.parse(localStorage.getItem("af_mind_spaces") ?? "[]"));
    } catch {
      /* no spaces yet */
    }
  }, []);

  const persistSpaces = useCallback((next: Space[]) => {
    setSpaces(next);
    localStorage.setItem("af_mind_spaces", JSON.stringify(next));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/mind");
      const data = await response.json();
      setItems(data.items ?? []);
    } catch {
      /* wall is best-effort */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const capture = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setInput("");
      try {
        const response = await fetch("/api/mind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, keys: keys() }),
        });
        if (response.ok) await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  const captureFile = useCallback(
    async (file: File) => {
      if (busy) return;
      setBusy(true);
      try {
        if (file.type.startsWith("image/")) {
          // Dominant color, extracted in-page (canvas) — mymind's color search.
          const color = await new Promise<string | null>((resolve) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
              try {
                const canvas = document.createElement("canvas");
                const size = 24;
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                if (!ctx) return resolve(null);
                ctx.drawImage(img, 0, 0, size, size);
                const { data } = ctx.getImageData(0, 0, size, size);
                const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
                for (let i = 0; i < data.length; i += 4) {
                  const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
                  if (a < 128) continue;
                  const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
                  const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
                  bucket.n += 1;
                  bucket.r += r;
                  bucket.g += g;
                  bucket.b += b;
                  buckets.set(key, bucket);
                }
                const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
                if (!best) return resolve(null);
                const hex = `#${[best.r, best.g, best.b].map((c) => Math.round(c / best.n).toString(16).padStart(2, "0")).join("")}`;
                resolve(hex);
              } catch {
                resolve(null);
              } finally {
                URL.revokeObjectURL(url);
              }
            };
            img.onerror = () => resolve(null);
            img.src = url;
          });
          // v1: image bytes stay local (object URL preview is transient) —
          // we store name + color + auto-tags; file bytes handling is Wave 5.
          const response = await fetch("/api/mind", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: `Image: ${file.name}`,
              kind: "image",
              color: color ?? undefined,
              name: file.name,
              keys: keys(),
            }),
          });
          if (response.ok) await refresh();
          return;
        }
        const text = await file.text();
        if (text.trim()) await capture(`File ${file.name}:\n${text.slice(0, 4000)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, capture, refresh],
  );

  const toggleFavorite = useCallback(async (id: string) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)));
    await fetch("/api/mind", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  }, []);

  const remove = useCallback(
    async (id: string) => {
      setItems((list) => list.filter((item) => item.id !== id));
      await fetch(`/api/mind?id=${id}`, { method: "DELETE" });
    },
    [],
  );

  const filtered = useMemo(() => {
    let list = items;
    const space = spaces.find((s) => s.name === activeSpace);
    if (space) list = list.filter((item) => smartSpaceMatches(item, space));
    if (kind) list = list.filter((item) => item.kind === kind);
    if (favoritesOnly) list = list.filter((item) => item.favorite);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((item) =>
        `${item.name} ${item.description} ${item.tags.join(" ")} ${item.content ?? ""}`.toLowerCase().includes(term),
      );
    }
    return list;
  }, [items, spaces, activeSpace, kind, favoritesOnly, q]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [items]);

  const saveCurrentSearchAsSpace = useCallback(() => {
    const name = q.trim() || (kind ? `${kind}s` : "Everything");
    const unique = spaces.some((s) => s.name === name) ? `${name} ${spaces.length + 1}` : name;
    persistSpaces([...spaces, { name: unique, tags: [], kinds: kind ? [kind] : [], q: q.trim() || undefined }]);
    setActiveSpace(unique);
    setQ("");
    setKind("");
  }, [q, kind, spaces, persistSpaces]);

  const surprise = useCallback(() => {
    if (filtered.length === 0) return;
    const pick = filtered[Math.floor(Math.random() * filtered.length)];
    setHighlight(pick.id);
    document.getElementById(`mind-${pick.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlight(null), 4000);
  }, [filtered]);

  return (
    <main
      className="mx-auto max-w-6xl px-6 py-10"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) void captureFile(file);
      }}
    >
      <h1 className="text-3xl font-black text-white">The Mind</h1>
      <p className="mt-2 text-sm text-slate-400">
        Throw anything in — thoughts, links, quotes, images. It gets tagged and summarized automatically; search finds it later. No folders, no filing.
      </p>

      <div className="mt-6 flex gap-2">
        <input
          className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void capture(input);
            }
          }}
          placeholder="Paste a thought, a link, or a quote — or drop an image anywhere…"
          disabled={busy}
        />
        <button
          onClick={() => void capture(input)}
          disabled={busy || !input.trim()}
          className="rounded-xl bg-violet-600 px-5 py-3 text-sm font-extrabold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? "Tagging…" : "Save"}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          title="Save a text or image file"
          className="rounded-xl border border-white/15 px-4 py-3 text-sm font-bold text-slate-300 hover:text-white"
        >
          📷
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void captureFile(file);
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="w-56 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your mind…"
        />
        <button className={`rounded-full border px-3 py-1 text-xs font-bold ${kind === "" ? "border-violet-400 bg-violet-600/30 text-white" : "border-white/15 text-slate-400"}`} onClick={() => setKind("")}>
          all
        </button>
        {KINDS.map((k) => (
          <button
            key={k}
            className={`rounded-full border px-3 py-1 text-xs font-bold ${kind === k ? "border-violet-400 bg-violet-600/30 text-white" : "border-white/15 text-slate-400 hover:text-white"}`}
            onClick={() => setKind(kind === k ? "" : k)}
          >
            {KIND_EMOJI[k]} {k}
          </button>
        ))}
        <button
          className={`rounded-full border px-3 py-1 text-xs font-bold ${favoritesOnly ? "border-amber-400 bg-amber-500/20 text-amber-200" : "border-white/15 text-slate-400"}`}
          onClick={() => setFavoritesOnly(!favoritesOnly)}
        >
          ★ favorites
        </button>
        <button className="rounded-full border border-white/15 px-3 py-1 text-xs font-bold text-slate-400 hover:text-white" onClick={saveCurrentSearchAsSpace}>
          + space from this search
        </button>
        <button className="rounded-full border border-white/15 px-3 py-1 text-xs font-bold text-slate-400 hover:text-white" onClick={surprise}>
          🎲 serendipity
        </button>
      </div>

      {spaces.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">smart spaces</span>
          {spaces.map((space) => (
            <span key={space.name} className="group flex items-center gap-1">
              <button
                className={`rounded-full px-3 py-1 text-xs font-bold ${activeSpace === space.name ? "bg-emerald-500/20 text-emerald-200" : "bg-white/5 text-slate-300 hover:text-white"}`}
                onClick={() => setActiveSpace(activeSpace === space.name ? "" : space.name)}
              >
                {space.name}
              </button>
              <button
                className="text-[10px] text-slate-600 opacity-0 group-hover:opacity-100"
                title="delete space"
                onClick={() => {
                  persistSpaces(spaces.filter((s) => s.name !== space.name));
                  if (activeSpace === space.name) setActiveSpace("");
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {allTags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {allTags.map(([tag, count]) => (
            <button key={tag} className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-slate-400 hover:text-white" onClick={() => setQ(tag)}>
              {tag} · {count}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="mt-16 text-center text-sm text-slate-500">
          {items.length === 0 ? "Nothing here yet — paste your first thought above." : "Nothing matches that filter."}
        </p>
      ) : (
        <div className="mt-6 columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              id={`mind-${item.id}`}
              className={`break-inside-avoid rounded-2xl border p-4 transition-shadow ${highlight === item.id ? "border-amber-400 shadow-[0_0_30px_rgba(251,191,36,0.25)]" : "border-white/10"} bg-white/[0.03]`}
              style={item.color ? { background: `linear-gradient(135deg, ${item.color}22, rgba(255,255,255,0.03))` } : undefined}
            >
              <div className="flex items-start gap-2">
                <span className="text-lg">{KIND_EMOJI[item.kind] ?? "📦"}</span>
                <div className="min-w-0 flex-1">
                  {item.kind === "link" && item.content ? (
                    <a href={item.content} target="_blank" rel="noreferrer" className="block truncate text-sm font-bold text-violet-300 hover:underline">
                      {item.name}
                    </a>
                  ) : (
                    <p className="truncate text-sm font-bold text-white">{item.name}</p>
                  )}
                  <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-slate-300">{item.content ?? item.description}</p>
                </div>
                <button className={`text-lg ${item.favorite ? "text-amber-300" : "text-slate-600 hover:text-amber-200"}`} onClick={() => void toggleFavorite(item.id)}>
                  ★
                </button>
              </div>
              {item.description && item.kind !== "note" && item.kind !== "quote" && (
                <p className="mt-2 text-[11px] italic text-slate-400">{item.description}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {item.color && <span className="inline-block h-3 w-3 rounded-full border border-white/20" style={{ background: item.color }} />}
                {item.tags.slice(0, 5).map((tag) => (
                  <span key={tag} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {tag}
                  </span>
                ))}
                <span className="ml-auto text-[9px] text-slate-600" title="who tagged this">
                  {item.engine}
                </span>
                <button className="text-[10px] text-slate-600 hover:text-rose-400" onClick={() => void remove(item.id)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
