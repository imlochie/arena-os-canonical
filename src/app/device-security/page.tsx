"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPrivacySettings } from "@/lib/privacyClient";

/**
 * Device Security — what Arena can HONESTLY observe about this environment.
 *
 * Everything here is measured in your browser via standard web APIs. Arena has
 * no native agent, no OS access, and no system telemetry — so it does NOT
 * claim antivirus state, OS malware status, firewall state, hardware security,
 * system-wide permissions, or any process outside this browser tab. Anything
 * it cannot measure says "not observable from the browser".
 */

type Verdict = "pass" | "warn" | "fail" | "info";

interface Check {
  id: string;
  area: string;
  name: string;
  verdict: Verdict;
  value: string;
  detail: string;
}

const CANNOT_CHECK = [
  "Antivirus / OS malware state — no native agent",
  "Firewall or router state — outside the browser sandbox",
  "Hardware security (TPM/Secure Enclave) — not exposed to web pages",
  "System-wide permissions or other apps' processes",
  "Files or processes outside this browser tab",
];

export default function DeviceSecurityPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);

  useEffect(() => {
    const out: Check[] = [];
    const add = (c: Check) => out.push(c);

    // ── Transport / context ────────────────────────────────────────────────
    const secure = typeof window !== "undefined" && window.isSecureContext;
    add({
      id: "secure-context",
      area: "Transport",
      name: "Secure context",
      verdict: secure ? "pass" : "fail",
      value: secure ? "yes" : "no",
      detail: secure
        ? "This page runs in a secure context (HTTPS or localhost) — WebCrypto, and other powerful APIs are available."
        : "Not a secure context. Sensitive browser APIs are disabled or degraded.",
    });
    add({
      id: "protocol",
      area: "Transport",
      name: "Protocol",
      verdict: location.protocol === "https:" ? "pass" : location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "info" : "warn",
      value: location.protocol.replace(":", ""),
      detail:
        location.protocol === "https:"
          ? "Traffic to Arena is encrypted in transit."
          : "Plain HTTP. Acceptable on localhost; over a network your traffic is not encrypted.",
    });

    // ── Crypto ─────────────────────────────────────────────────────────────
    const hasSubtle = typeof crypto !== "undefined" && !!crypto.subtle;
    add({
      id: "webcrypto",
      area: "Cryptography",
      name: "WebCrypto (AES-GCM, scrypt)",
      verdict: hasSubtle ? "pass" : "fail",
      value: hasSubtle ? "available" : "unavailable",
      detail: hasSubtle
        ? "Arena's ephemeral-reveal sealing and privacy tooling can operate."
        : "crypto.subtle missing — sealed ephemeral reveals cannot be created.",
    });

    // ── GPU / runtime ──────────────────────────────────────────────────────
    add({
      id: "webgpu",
      area: "Local runtime",
      name: "WebGPU (Level 1 on-device LLM)",
      verdict: "info",
      value: "checking…",
      detail: "Whether WebLLM can run real model inference in this browser.",
    });
    setChecks([...out]);
    import("@/lib/webllm")
      .then(async ({ checkWebGPU }) => {
        const r = await checkWebGPU();
        setChecks((cs) =>
          cs.map((c) =>
            c.id === "webgpu"
              ? {
                  ...c,
                  verdict: r.ok ? "pass" : "warn",
                  value: r.ok ? "available" : "unavailable",
                  detail: r.ok
                    ? "This browser can run WebLLM models on-device (LEVEL 1)."
                    : `WebGPU unavailable (${r.reason ?? "not supported"}) — on-device LLM via WebLLM cannot run here; it will report honestly as unavailable.`,
                }
              : c,
          ),
        );
      })
      .catch(() => {});

    // ── Storage ────────────────────────────────────────────────────────────
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((est) => {
        const used = est.usage ?? 0;
        const quota = est.quota ?? 0;
        setChecks((cs) => [
          ...cs,
          {
            id: "storage",
            area: "Storage",
            name: "Storage quota & usage",
            verdict: "info",
            value: quota ? `${(used / 1048576).toFixed(1)} MB used / ${(quota / 1048576).toFixed(0)} MB quota` : "estimate unavailable",
            detail: "Browser-granted storage for this origin (model caches, projects). Data is sandboxed to this origin.",
          },
        ]);
      });
    } else {
      setChecks((cs) => [
        ...cs,
        { id: "storage", area: "Storage", name: "Storage quota & usage", verdict: "info", value: "not observable", detail: "navigator.storage.estimate() is not available in this browser." },
      ]);
    }
    if (navigator.storage?.persisted) {
      navigator.storage.persisted().then((p) => {
        setChecks((cs) => [
          ...cs,
          {
            id: "storage-persist",
            area: "Storage",
            name: "Persistent storage",
            verdict: p ? "pass" : "info",
            value: p ? "granted" : "not granted",
            detail: p
              ? "The browser will not evict this origin's data (model weights, projects) under pressure."
              : "The browser may evict stored data under storage pressure — downloads may need re-fetching.",
          },
        ]);
      });
    }

    // ── Permissions (only what the browser exposes) ────────────────────────
    const PERMS: [string, string][] = [
      ["camera", "Camera"],
      ["microphone", "Microphone"],
      ["notifications", "Notifications"],
    ];
    for (const [name, label] of PERMS) {
      if (navigator.permissions?.query) {
        navigator.permissions
          .query({ name: name as PermissionName })
          .then((st) => {
            setChecks((cs) => [
              ...cs,
              {
                id: `perm-${name}`,
                area: "Permissions",
                name: `${label} permission`,
                verdict: st.state === "granted" ? "warn" : st.state === "denied" ? "info" : "info",
                value: st.state,
                detail:
                  st.state === "granted"
                    ? "GRANTED — a page on this origin can use it. Revoke in browser settings if you did not intend this."
                    : st.state === "denied"
                      ? "Denied — pages on this origin cannot use it."
                      : "Not requested yet — pages must ask first.",
              },
            ]);
          })
          .catch(() => {
            setChecks((cs) => [
              ...cs,
              { id: `perm-${name}`, area: "Permissions", name: `${label} permission`, verdict: "info", value: "not observable", detail: "This browser does not expose the permission query API for this permission." },
            ]);
          });
      } else {
        setChecks((cs) => [
          ...cs,
          { id: `perm-${name}`, area: "Permissions", name: `${label} permission`, verdict: "info", value: "not observable", detail: "navigator.permissions is not available." },
        ]);
      }
    }

    // ── Arena privacy posture ──────────────────────────────────────────────
    const ps = getPrivacySettings();
    setChecks((cs) => [
      ...cs,
      {
        id: "local-mode",
        area: "Arena posture",
        name: "Local Mode (zero egress)",
        verdict: ps.localMode ? "pass" : "info",
        value: ps.localMode ? "ON" : "OFF",
        detail: ps.localMode
          ? "All AI generation is forced to the Arena Local Engine — no network egress from AI surfaces."
          : "Remote models may be contacted when selected. Turn Local Mode on in Privacy Controls to force zero egress.",
      },
      {
        id: "ephemeral",
        area: "Arena posture",
        name: "Ephemeral mode",
        verdict: "info",
        value: ps.ephemeral ? "ON" : "OFF",
        detail: ps.ephemeral
          ? "Chat and battle transcripts are not persisted by Arena."
          : "Transcripts persist to your local database (never sent anywhere else).",
      },
    ]);

    // ── Arena server reachability (same-origin) ────────────────────────────
    fetch("/api/privacy/summary")
      .then((r) => setApiReachable(r.ok))
      .catch(() => setApiReachable(false));
    setRanAt(new Date().toISOString());
  }, []);

  const verdictTone: Record<Verdict, string> = {
    pass: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
    warn: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
    fail: "bg-red-400/15 text-red-300 ring-red-400/30",
    info: "bg-white/5 text-slate-300 ring-white/10",
  };

  const areas = [...new Set(checks.map((c) => c.area))];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-black text-white">🛡️ Device Security</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        An honest, browser-observable security and runtime posture check. Arena has <strong className="text-slate-200">no native agent</strong>{" "}
        and makes <strong className="text-slate-200">no OS-level claims</strong> — it inspects exactly what this
        browser tab can see, and says &quot;not observable&quot; for everything else.
      </p>
      {ranAt && <p className="mt-1 text-[11px] text-slate-500">Checked at {new Date(ranAt).toLocaleTimeString()}</p>}

      {apiReachable !== null && (
        <div
          className={`mt-4 rounded-xl border p-3 text-sm ${
            apiReachable
              ? "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100"
              : "border-red-400/25 bg-red-400/[0.07] text-red-100"
          }`}
        >
          {apiReachable ? "✓ Arena server (same-origin) reachable — local services responding." : "✗ Arena server unreachable — local services are down or the app was rebuilt."}
        </div>
      )}

      <div className="mt-6 space-y-5">
        {areas.map((area) => (
          <section key={area} className="glass rounded-2xl p-5">
            <h2 className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">{area}</h2>
            <div className="mt-3 space-y-2.5">
              {checks
                .filter((c) => c.area === area)
                .map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-3 border-b border-white/5 pb-2.5 last:border-0 last:pb-0" data-testid={`check-${c.id}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white">{c.name}</p>
                      <p className="mt-0.5 text-xs leading-5 text-slate-400">{c.detail}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${verdictTone[c.verdict]}`}>
                      {c.value}
                    </span>
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>

      <section className="glass mt-5 rounded-2xl border-white/10 p-5">
        <h2 className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">What this page cannot check — and will not pretend to</h2>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-400">
          {CANNOT_CHECK.map((c) => (
            <li key={c} className="flex gap-2">
              <span className="text-slate-600">✕</span>
              {c}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          For data-handling controls (no-training contract, egress logs, wipe), see{" "}
          <Link href="/privacy" className="font-semibold text-cyan-300 hover:underline">
            Privacy
          </Link>
          . Privacy is a separate surface: it governs what Arena does with your data. This page measures the
          environment Arena runs in.
        </p>
      </section>
    </div>
  );
}
