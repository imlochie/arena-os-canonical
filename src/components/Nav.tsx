"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import PrivacyControls from "./PrivacyControls";

/**
 * Navigation — calm by design.
 *
 * Every destination stays reachable (nothing was removed); they're just
 * organized so the eye has 3 decisions, not 22:
 *
 *   1. A primary rail: Arena · Chat · Spaces (the daily surfaces)
 *   2. One "Rooms" menu (button, opens a grouped, type-to-filter launcher —
 *      also toggled with Cmd/Ctrl+K anywhere)
 *   3. Status controls on the right
 */

interface RoomLink {
  href: string;
  label: string;
  emoji: string;
  desc: string;
  keywords: string;
}

const GROUPS: { title: string; rooms: RoomLink[] }[] = [
  {
    title: "Start here",
    rooms: [
      { href: "/command", label: "Command", emoji: "🧭", desc: "Not sure where to start? Answer one question.", keywords: "help start what to do navigation hub" },
      { href: "/", label: "Arena", emoji: "⚔️", desc: "Blind model battles, ELO from your votes.", keywords: "battle vote compare home versus" },
      { href: "/chat", label: "Chat", emoji: "💬", desc: "Direct conversation with the brain you pick.", keywords: "message talk assistant conversation" },
    ],
  },
  {
    title: "Agents & teams",
    rooms: [
      { href: "/spaces", label: "Spaces", emoji: "🧩", desc: "Agent fleets, missions, watchers.", keywords: "automation agents fleet mission workspace watch" },
      { href: "/orchestrator", label: "Orchestrator", emoji: "🪢", desc: "Pick a workflow for the work.", keywords: "workflow route pipeline" },
      { href: "/council", label: "Council", emoji: "🧠", desc: "Compare perspectives, synthesize.", keywords: "debate compare perspectives" },
      { href: "/congress", label: "Congress", emoji: "🏛️", desc: "Timed multi-seat deliberation.", keywords: "debate seats deliberation vote" },
      { href: "/assistants", label: "Assistants", emoji: "🧬", desc: "Design custom assistants.", keywords: "persona system prompt custom" },
    ],
  },
  {
    title: "Create",
    rooms: [
      { href: "/waveyard", label: "Waveyard", emoji: "🎚️", desc: "The music studio: stems, remixes, exports.", keywords: "music audio stems separation remix" },
      { href: "/arcade", label: "Arcade", emoji: "🎮", desc: "Forge any game — templates or AI.", keywords: "game tetris play generate" },
      { href: "/image", label: "Image", emoji: "🖼️", desc: "Generate images.", keywords: "picture draw art" },
      { href: "/luma", label: "LUMA", emoji: "📷", desc: "The image workshop.", keywords: "photo picture edit" },
    ],
  },
  {
    title: "Work & study",
    rooms: [
      { href: "/projects", label: "Projects", emoji: "📁", desc: "Long-lived work with artifacts.", keywords: "folders work organize" },
      { href: "/collab", label: "Collab", emoji: "🤝", desc: "Models collaborate, best result wins.", keywords: "collaborate together lab" },
      { href: "/classroom", label: "Classroom", emoji: "🎓", desc: "Learn with the arena.", keywords: "learn study teach" },
      { href: "/college", label: "College", emoji: "🏫", desc: "The Lochie Life College: timetable, faculty, governance.", keywords: "college institution timetable faculty governance curriculum campus study" },
      { href: "/cut", label: "Cut Lab", emoji: "✂️", desc: "Edit and split media.", keywords: "cut split edit media" },
    ],
  },
  {
    title: "Results & records",
    rooms: [
      { href: "/artifacts", label: "Artifacts", emoji: "📦", desc: "Everything that was produced.", keywords: "outputs files deliverables" },
      { href: "/handoffs", label: "Handoffs", emoji: "🤲", desc: "Work passed between rooms.", keywords: "handoff transfer ledger" },
      { href: "/leaderboard", label: "Leaderboard", emoji: "🏆", desc: "Your personal ELO rankings.", keywords: "elo rank board scores" },
      { href: "/benchmark", label: "Benchmark", emoji: "⏱", desc: "Speed and quality measurements.", keywords: "speed latency measure" },
    ],
  },
  {
    title: "System",
    rooms: [
      { href: "/rooms", label: "All rooms", emoji: "🗺️", desc: "The full directory.", keywords: "directory all overview" },
      { href: "/runtime", label: "Runtime", emoji: "⚙️", desc: "Which brains run, and where.", keywords: "engine model levels local" },
      { href: "/guide", label: "Guide", emoji: "📘", desc: "Clone and self-host instructions.", keywords: "clone deploy self host docs" },
      { href: "/privacy", label: "Privacy", emoji: "🛡️", desc: "Never trained on. Local-first.", keywords: "data protection security" },
    ],
  },
];

const PRIMARY = [
  { href: "/", label: "Arena", emoji: "⚔️" },
  { href: "/chat", label: "Chat", emoji: "💬" },
  { href: "/spaces", label: "Spaces", emoji: "🧩" },
];

const ALL_ROOMS = GROUPS.flatMap((g) => g.rooms);

export default function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on route change.
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [pathname]);

  // Cmd/Ctrl+K toggles the launcher; Esc closes; click-outside closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  // Focus the filter field when the launcher opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      rooms: g.rooms.filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.keywords.toLowerCase().includes(q) ||
          r.desc.toLowerCase().includes(q),
      ),
    })).filter((g) => g.rooms.length > 0);
  }, [query]);

  const activeRoom = ALL_ROOMS.find((r) => r.href === pathname);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#060a17]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" title="Home">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 text-lg shadow-[0_8px_24px_rgba(124,58,237,0.5)]">
            ⚔️
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-[15px] font-extrabold tracking-tight text-white">Arena</span>
            <span className="block text-[10px] font-semibold text-slate-500">free · private · yours</span>
          </span>
        </Link>

        {/* Primary rail: three daily surfaces + the launcher */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {PRIMARY.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-2 text-[13px] font-bold transition ${
                  active
                    ? "bg-violet-600/25 text-white ring-1 ring-violet-500/50"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span className="mr-1.5">{l.emoji}</span>
                {l.label}
              </Link>
            );
          })}
          <button
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={open}
            className={`ml-1 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-bold transition ${
              open || activeRoom
                ? "bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40"
                : "text-slate-300 ring-1 ring-white/10 hover:bg-white/5 hover:text-white"
            }`}
            title="All rooms (Ctrl+K)"
          >
            {activeRoom && !open ? (
              <>
                <span>{activeRoom.emoji}</span>
                {activeRoom.label}
              </>
            ) : (
              <>🗺️ Rooms</>
            )}
            <span className={`text-[10px] text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
          </button>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden xl:block">
            <PrivacyControls compact />
          </div>
          <Link
            href="/privacy"
            title="Data protection — never trained on, local-first, offline-ready"
            className={`rounded-lg px-2.5 py-2 text-sm font-bold transition ${
              pathname === "/privacy"
                ? "bg-emerald-600/25 text-white ring-1 ring-emerald-500/50"
                : "text-slate-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            🛡️
          </Link>
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-white md:hidden"
            aria-label="Menu"
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {/* Rooms launcher — grouped, filterable, keyboard-first */}
      {open && (
        <div ref={menuRef} className="border-t border-white/10 bg-[#080d1e]/95 backdrop-blur-xl">
          <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const first = filteredGroups[0]?.rooms[0];
                  if (first) window.location.assign(first.href);
                }
              }}
              placeholder="Where do you want to go? Type to filter… (Enter opens the first match)"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
            />
            <div className="scroll-thin mt-3 grid max-h-[60vh] gap-x-6 gap-y-4 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {filteredGroups.map((g) => (
                <div key={g.title}>
                  <p className="section-label mb-1.5">{g.title}</p>
                  <div className="grid gap-1">
                    {g.rooms.map((r) => {
                      const active = pathname === r.href;
                      return (
                        <Link
                          key={r.href}
                          href={r.href}
                          className={`group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition ${
                            active ? "bg-violet-600/20 ring-1 ring-violet-500/40" : "hover:bg-white/5"
                          }`}
                        >
                          <span className="mt-0.5 text-base">{r.emoji}</span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-bold text-white group-hover:text-cyan-200">
                              {r.label}
                            </span>
                            <span className="block truncate text-[11px] leading-snug text-slate-500">{r.desc}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
              {filteredGroups.length === 0 && (
                <p className="col-span-full py-6 text-center text-sm text-slate-500">
                  Nothing matches “{query}” — try “chat”, “music”, “agents”, “game”…
                </p>
              )}
            </div>
            <p className="mt-3 text-center text-[10px] text-slate-600">
              Every room stays one keystroke away — <b className="text-slate-500">Ctrl/⌘ K</b> opens this launcher anywhere · Esc closes
            </p>
          </div>
        </div>
      )}
    </header>
  );
}
