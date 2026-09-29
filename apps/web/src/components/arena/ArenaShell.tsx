"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ARENA_NAVIGATION_ROOMS } from "@/lib/arena-rooms";

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
            {ARENA_NAVIGATION_ROOMS.map((room) => (
              <Link
                key={room.id}
                className="arena-nav-link"
                href={room.href!}
                aria-current={isActive(pathname, room.href!) ? "page" : undefined}
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
