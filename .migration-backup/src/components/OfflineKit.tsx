"use client";

import { useEffect, useState } from "react";

export function SwRegister() {
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}

export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  if (online) return null;
  return (
    <div className="border-b border-amber-400/30 bg-amber-500/15 px-4 py-2 text-center text-xs font-bold text-amber-200">
      📴 You&apos;re offline — Local Mode auto-enabled. Battles, collabs, chat, judge & image canvas all work.
      Nothing leaves your machine. <a href="/privacy" className="underline">Privacy Center</a>
    </div>
  );
}
