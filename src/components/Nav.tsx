"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import PrivacyControls from "./PrivacyControls";

const LINKS = [
  { href: "/command", label: "Command", emoji: "🧭" },
  { href: "/", label: "Arena", emoji: "⚔️" },
  { href: "/council", label: "Council", emoji: "🧠" },
  { href: "/collab", label: "Collab", emoji: "🤝" },
  { href: "/projects", label: "Projects", emoji: "📁" },
  { href: "/artifacts", label: "Artifacts", emoji: "📦" },
  { href: "/arcade", label: "Arcade", emoji: "🎮" },
  { href: "/chat", label: "Chat", emoji: "💬" },
  { href: "/image", label: "Image", emoji: "🖼️" },
  { href: "/stems", label: "Stems", emoji: "🎚️" },
  { href: "/assistants", label: "Assistants", emoji: "🧬" },
  { href: "/leaderboard", label: "Board", emoji: "🏆" },
  { href: "/guide", label: "Guide", emoji: "📦" },
];

export default function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#060a17]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 text-lg shadow-[0_8px_24px_rgba(124,58,237,0.5)]">
            ⚔️
          </span>
          <span className="leading-tight">
            <span className="block text-[15px] font-extrabold tracking-tight text-white">
              ArenaForge <span className="bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent">Personal</span>
            </span>
            <span className="block text-[11px] font-medium text-slate-400">
              Your free private AI arena · $0 forever
            </span>
          </span>
        </Link>

        <nav className="scroll-thin hidden max-w-[640px] items-center gap-1 overflow-x-auto lg:flex xl:max-w-none">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-2 py-2 text-[13px] font-semibold transition ${
                  active
                    ? "bg-violet-600/25 text-white ring-1 ring-violet-500/50"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span className="mr-1">{l.emoji}</span>
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden xl:block">
            <PrivacyControls compact />
          </div>
          <Link
            href="/privacy"
            title="Data Protection Center — never trained on, local-first, offline-ready"
            className={`rounded-lg px-2.5 py-2 text-sm font-bold transition ${
              pathname === "/privacy"
                ? "bg-emerald-600/25 text-white ring-1 ring-emerald-500/50"
                : "text-slate-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            🛡️
          </Link>
          <button
            onClick={() => setOpen(!open)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-white lg:hidden"
            aria-label="Menu"
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>
      {open && (
        <nav className="grid gap-1 border-t border-white/10 px-4 py-3 lg:hidden">
          <div className="px-1 pb-2">
            <PrivacyControls compact />
          </div>
          {[...LINKS, { href: "/privacy", label: "Privacy", emoji: "🛡️" }].map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                  active ? "bg-violet-600/25 text-white" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <span className="mr-2">{l.emoji}</span>
                {l.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
