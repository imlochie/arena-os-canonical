import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import Nav from "@/components/Nav";
import { OfflineBanner, SwRegister } from "@/components/OfflineKit";

export const metadata: Metadata = {
  title: "ArenaForge Personal — Your Free Private AI Arena",
  description:
    "Blind battles, collab lab, leaderboards. Local Mode works fully offline. Never trained on. $0 forever.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
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
        <footer className="border-t border-white/10 py-6">
          <p className="mx-auto max-w-7xl px-4 text-center text-xs text-slate-500 sm:px-6">
            ⚔️ ArenaForge Personal · blind battles · ELO-ranked · 100% free tier · your votes train{" "}
            <em>your</em> leaderboard — not someone else&apos;s ·{" "}
            <a href="/privacy" className="font-bold text-emerald-300/80 hover:underline">
              🛡️ never trained on · local-first · offline-ready
            </a>{" "}
            ·{" "}
            <a href="/principles" className="font-bold text-slate-400 hover:underline">
              📜 use principles
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
