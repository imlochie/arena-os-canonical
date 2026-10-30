
import type { ReactNode } from "react";
import "./globals.css";
import Nav from "@/components/Nav";
import DesktopRuntimeStatus from "@/components/DesktopRuntimeStatus";
import { OfflineBanner, SwRegister } from "@/components/OfflineKit";

export const metadata = {
  title: "ArenaForge Personal — AI tools for work",
  description:
    "A workspace for chat, media, music, games, and browser tasks. Runtime and storage behavior vary by tool.",
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: "#060a17",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-arena min-h-screen antialiased">
        <SwRegister />
        <OfflineBanner />
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6">{children}</main>
        <DesktopRuntimeStatus />
        <footer className="border-t border-white/10 py-5">
          <p className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 text-center text-xs text-slate-500 sm:px-6">
            <span>ArenaForge Personal · your votes train <em>your</em> leaderboard</span>
            <span className="text-slate-700">·</span>
            <a href="/privacy" className="font-bold text-emerald-300/80 hover:underline">
              🛡️ Privacy and data handling
            </a>
            <span className="text-slate-700">·</span>
            <a href="/principles" className="font-bold text-slate-400 hover:underline">
              📜 Principles
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
