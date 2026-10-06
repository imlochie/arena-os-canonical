import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Info,
  Link2Off,
  ShieldAlert,
} from "lucide-react";
import type { ArchiveBridgeStatus } from "@/lib/archive-assistant/bridge-status";

/**
 * Presentational panel for the Archive Assistant room. All facts shown are
 * computed server-side by getArchiveBridgeStatus(); this component never
 * calls the Archive Assistant app itself.
 */
export default function ArchiveAssistantBridge({
  status,
}: {
  status: ArchiveBridgeStatus;
}) {
  if (status.state === "connected") {
    return (
      <div
        className="mt-8 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-4"
        data-testid="archive-bridge-connected"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2
            className="mt-0.5 shrink-0 text-emerald-200"
            size={18}
            aria-hidden="true"
          />
          <div className="w-full">
            <p className="text-sm font-bold text-emerald-100">
              Connected to Archive Assistant
              <span className="ml-2 font-mono text-[11px] font-normal text-emerald-200/70">
                {status.host}
              </span>
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Health
                </p>
                <p className="mt-1 text-sm font-bold text-white">
                  {status.health}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Attention
                </p>
                <p className="mt-1 text-sm font-bold text-white">
                  {status.attentionCount}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Scan
                </p>
                <p className="mt-1 text-sm font-bold text-white">
                  {status.scanStatus}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Acquisition jobs
                </p>
                <p className="mt-1 text-sm font-bold text-white">
                  {status.acquisitionJobs}
                </p>
              </div>
            </div>
            {status.informational.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {status.informational.map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-2 text-xs leading-5 text-slate-400"
                  >
                    <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Read-only six-operation bridge (overview, workload, reconciliation,
              finding lineage, provider state + history). The full bounded context
              is available at{" "}
              <a
                href="/api/archive/context"
                className="font-bold text-cyan-200 hover:text-white"
              >
                /api/archive/context
              </a>
              . Arena can never approve, reject, execute, move, or sync anything
              in Archive Assistant.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status.state === "unconfigured") {
    return (
      <div
        className="mt-8 rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-4"
        data-testid="archive-bridge-unconfigured"
      >
        <div className="flex items-start gap-3">
          <Link2Off
            className="mt-0.5 shrink-0 text-amber-200"
            size={18}
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-bold text-amber-100">
              Bridge mounted, not configured
            </p>
            <p className="mt-1 text-sm leading-5 text-slate-400">
              The Archive Assistant bridge code is installed on this server. Set{" "}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-cyan-100">
                ARCHIVE_ASSISTANT_API_URL
              </code>{" "}
              (plus{" "}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-cyan-100">
                ARCHIVE_ASSISTANT_AUTH_MODE=local
              </code>{" "}
              and{" "}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-cyan-100">
                ARCHIVE_ASSISTANT_OWNER_ID
              </code>{" "}
              for a locally running app) in the server environment to connect it.
              See the README.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status.state === "bearer-configured") {
    return (
      <div
        className="mt-8 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.05] p-4"
        data-testid="archive-bridge-bearer"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert
            className="mt-0.5 shrink-0 text-cyan-200"
            size={18}
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-bold text-cyan-100">
              Bearer mode configured
              <span className="ml-2 font-mono text-[11px] font-normal text-cyan-200/70">
                {status.host}
              </span>
            </p>
            <p className="mt-1 text-sm leading-5 text-slate-400">
              The bridge forwards an authenticated user&apos;s bearer token to
              Archive Assistant. Page-level probes are not performed in this
              mode; request the full context with credentials from{" "}
              <a
                href="/api/archive/context"
                className="font-bold text-cyan-200 hover:text-white"
              >
                /api/archive/context
                <ExternalLink size={11} className="ml-1 inline" aria-hidden="true" />
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    );
  }

  const tone =
    status.state === "auth-required" || status.state === "contract-mismatch"
      ? "border-amber-300/15 bg-amber-300/[0.05] text-amber-100"
      : "border-slate-300/15 bg-slate-300/[0.05] text-slate-200";
  const label =
    status.state === "auth-required"
      ? "Configured, but the app rejected the owner id"
      : status.state === "contract-mismatch"
        ? "Configured, but the response does not match the pinned contract"
        : "Configured, but unreachable right now";

  return (
    <div
      className={`mt-8 rounded-2xl border p-4 ${tone}`}
      data-testid={`archive-bridge-${status.state}`}
    >
      <div className="flex items-start gap-3">
        <CircleAlert
          className="mt-0.5 shrink-0"
          size={18}
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-bold">
            {label}
            <span className="ml-2 font-mono text-[11px] font-normal opacity-70">
              {status.host}
            </span>
          </p>
          <p className="mt-1 break-words text-xs leading-5 text-slate-500">
            {status.detail}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            The bridge is read-only and fails closed; nothing is cached or
            invented while the app is unreachable.
          </p>
        </div>
      </div>
    </div>
  );
}
