"use client";

/**
 * Desktop runtime status — the user-facing surface of the diagnostics IPC
 * (window.arenaDesktop.getDiagnostics), rendered ONLY inside the Arena
 * desktop shell. In a plain browser the preload bridge does not exist and
 * this component renders nothing — browser behaviour is untouched.
 *
 * Shows the honest per-subsystem state (READY / DEGRADED / UNAVAILABLE with
 * the real reason from the diagnostics checks), the app version, and a
 * copy-summary action for bug reports. Never invents a status: if the
 * diagnostics call fails, it says so.
 */

import { useEffect, useState } from "react";

type ComponentStatus = "READY" | "DEGRADED" | "UNAVAILABLE";

interface ComponentReport {
  status: ComponentStatus;
  reason?: string;
  detail?: Record<string, unknown>;
}

interface SubsystemsReport {
  overall: ComponentStatus;
  components: Record<string, ComponentReport>;
  checkedAt: string;
}

interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  dataDir: string;
  channel: string;
}

const REFRESH_MS = 15_000;

function worst(components: Record<string, ComponentReport>): ComponentStatus {
  const values = Object.values(components);
  if (values.some((c) => c.status === "UNAVAILABLE")) return "UNAVAILABLE";
  if (values.some((c) => c.status === "DEGRADED")) return "DEGRADED";
  return values.length > 0 ? "READY" : "DEGRADED";
}

const STATUS_STYLES: Record<ComponentStatus, string> = {
  READY: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  DEGRADED: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  UNAVAILABLE: "bg-red-500/15 text-red-300 border-red-400/30",
};

const STATUS_DOTS: Record<ComponentStatus, string> = {
  READY: "bg-emerald-400",
  DEGRADED: "bg-amber-400",
  UNAVAILABLE: "bg-red-400",
};

export default function DesktopRuntimeStatus() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [components, setComponents] = useState<Record<string, ComponentReport> | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Capability detection: no bridge → plain browser → render nothing.
    if (typeof window === "undefined" || window.arenaDesktop === undefined) return;

    const load = async () => {
      try {
        const diagnostics = await window.arenaDesktop?.getDiagnostics();
        if (diagnostics === undefined) return;
        if (diagnostics.subsystems !== null) {
          setComponents(diagnostics.subsystems.components);
          setUnreachable(false);
        } else {
          setComponents(null);
          setUnreachable(true);
        }
      } catch {
        setComponents(null);
        setUnreachable(true);
      }
    };

    window.arenaDesktop.getInfo().then(setInfo).catch(() => {});
    // First load + polling both run as callbacks, never synchronously in
    // the effect body.
    const kickoff = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, []);

  if (info === null) return null;

  const overall: ComponentStatus = unreachable ? "UNAVAILABLE" : components !== null ? worst(components) : "DEGRADED";

  const summary = [
    `Arena ${info.version} (${info.channel}) · ${info.platform} · Electron ${info.electron}`,
    `Data: ${info.dataDir}`,
    unreachable
      ? "Runtime diagnostics: UNAVAILABLE (local server unreachable)"
      : Object.entries(components ?? {})
          .map(([name, report]) => `${name}: ${report.status}${report.reason !== undefined ? ` — ${report.reason}` : ""}`)
          .join("\n"),
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the summary stays visible for manual copy */
    }
  };

  return (
    <div className="fixed bottom-3 right-3 z-50 print:hidden">
      {open && (
        <div
          role="dialog"
          aria-label="Desktop runtime diagnostics"
          tabIndex={-1}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          ref={(el) => el?.focus()}
          className="mb-2 w-80 rounded-xl border border-white/10 bg-[#0b0d12]/95 p-3 text-left shadow-2xl backdrop-blur"
        >
          <div className="flex items-center justify-between">
            <b className="text-xs text-white">Desktop runtime</b>
            <span className="text-[10px] text-slate-500">v{info.version} · {info.channel}</span>
          </div>
          {unreachable ? (
            <p className="mt-2 rounded-lg bg-red-500/10 p-2 text-[11px] leading-4 text-red-300">
              Local server unreachable — the runtime diagnostics could not be collected. If Arena looks broken, restart the app; details are in the logs folder.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {Object.entries(components ?? {}).map(([name, report]) => (
                <li key={name} className="text-[11px] leading-4">
                  <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${STATUS_DOTS[report.status]}`} />
                  <b className="text-slate-200">{name}</b>{" "}
                  <span className={report.status === "READY" ? "text-emerald-300" : report.status === "DEGRADED" ? "text-amber-300" : "text-red-300"}>
                    {report.status}
                  </span>
                  {report.reason !== undefined && <span className="block pl-3 text-slate-400">{report.reason}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
            <span className="truncate text-[10px] text-slate-500" title={info.dataDir}>{info.dataDir}</span>
            <button
              type="button"
              onClick={copy}
              className="rounded-lg bg-white/10 px-2 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/20"
              aria-label="Copy runtime diagnostics summary to clipboard"
            >
              {copied ? "Copied ✓" : "Copy diagnostics"}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Desktop runtime: ${overall}. ${open ? "Hide" : "Show"} diagnostics.`}
        className={`ml-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold shadow-lg backdrop-blur ${STATUS_STYLES[overall]}`}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOTS[overall]}`} />
        Runtime · {overall}
      </button>
    </div>
  );
}
