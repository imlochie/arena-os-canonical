"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const rooms = [
  { href: "/command", label: "Command", emoji: "🧭" },
  { href: "/", label: "Arena", emoji: "⚔️" },
  { href: "/council", label: "Council", emoji: "🧠" },
  { href: "/collab", label: "Collab", emoji: "🤝" },
  { href: "/projects", label: "Projects", emoji: "📁" },
  { href: "/artifacts", label: "Artifacts", emoji: "📦" },
  { href: "/chat", label: "Chat", emoji: "💬" },
  { href: "/assistants", label: "Assistants", emoji: "🧬" },
  { href: "/arcade", label: "Arcade", emoji: "🎮" },
  { href: "/image", label: "Image", emoji: "🖼️" },
  { href: "/leaderboard", label: "Board", emoji: "🏆" },
  { href: "/guide", label: "Guide", emoji: "📖" },
  { href: "/privacy", label: "Privacy", emoji: "🛡️" },
  { href: "/waveyard", label: "Waveyard", emoji: "〰️" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function ArenaShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const inWaveyard = pathname === "/waveyard" || pathname.startsWith("/waveyard/");

  return (
    <div className="arena-application">
      <header className="arena-shell-nav">
        <div className="arena-shell-inner">
          <Link className="arena-brand" href="/" aria-label="Arena home">
            <span className="arena-brand-mark" aria-hidden>✦</span>
            <span>
              Arena OS
              <span className="arena-brand-subtitle">personal AI hub · private by default</span>
            </span>
          </Link>
          <nav className="arena-nav-links" aria-label="Arena rooms">
            {rooms.map((room) => (
              <Link
                key={room.href}
                className="arena-nav-link"
                href={room.href}
                aria-current={isActive(pathname, room.href) ? "page" : undefined}
              >
                <span aria-hidden>{room.emoji}</span> {room.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {inWaveyard && (
        <aside className="arena-room-rail" aria-label="Current room">
          <p><strong>〰️ Waveyard room</strong> · music source intake, separation, analysis, remixing, playback, and exports remain owned by Waveyard.</p>
        </aside>
      )}
      <main className="arena-shell-main">{children}</main>
      <footer className="arena-footer">
        <p>Arena OS coordinates models, assistants, workforce, projects, memory, artifacts, and handoffs. Room-specific work stays with the room that owns it.</p>
      </footer>
    </div>
  );
}
