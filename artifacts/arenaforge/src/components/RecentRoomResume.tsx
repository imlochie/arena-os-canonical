import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import Link from "@/routing/Link";

const STORAGE_KEY = "arena:last-used-room:v1";
const UTILITY_ROUTES = new Set([
  "rooms",
  "runtime",
  "privacy",
  "principles",
  "settings",
  "login",
  "auth",
]);

function resumableRoomPath(pathname: string): string | null {
  const path = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/";
  const firstSegment = path.split("/").filter(Boolean)[0];
  if (!firstSegment || UTILITY_ROUTES.has(firstSegment)) return null;
  if (firstSegment === "waveyard" && path.startsWith("/waveyard/studio")) {
    return "/waveyard/studio";
  }
  return `/${firstSegment}`;
}

function roomName(path: string): string {
  if (path === "/waveyard/studio") return "Waveyard Studio";
  const segment = path.split("/").filter(Boolean)[0] ?? "";
  if (!segment) return "your last room";
  return segment.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function RecentRoomTracker() {
  const { pathname } = useLocation();

  useEffect(() => {
    const path = resumableRoomPath(pathname);
    if (path === null) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, path);
    } catch {
      // Remembering a room is optional; blocked browser storage must not affect navigation.
    }
  }, [pathname]);

  return null;
}

export default function RecentRoomResume() {
  const [path, setPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      setPath(saved?.startsWith("/") ? saved : null);
    } catch {
      setPath(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  if (!loaded || path === null) return null;
  const label = roomName(path);

  return (
    <section
      aria-label="Continue to your last room"
      className="glass mb-5 flex flex-col gap-3 rounded-2xl border border-violet-300/20 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-200/80">
          Pick up where you left off
        </p>
        <p className="mt-1 text-sm text-slate-300">
          Reopen <span className="font-extrabold text-white">{label}</span>, your last-used room on this device.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={path}
          className="btn rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-500"
        >
          Continue to {label}
        </Link>
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-white/5 hover:text-white"
          onClick={() => {
            try {
              window.localStorage.removeItem(STORAGE_KEY);
            } catch {
              // The card can still be dismissed for this render if storage is unavailable.
            }
            setPath(null);
          }}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
