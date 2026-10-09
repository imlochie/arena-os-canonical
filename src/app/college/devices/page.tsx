"use client";

// ============================================================================
// CONTROL ROOM — PAIRED SURFACES
// ============================================================================
// Where a phone becomes part of the College, and where it stops being part of
// it. Deliberately a desktop page: enrolling a device is an institutional act,
// and the API refuses it from the Campus surface anyway.
// ============================================================================

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Device {
  id: string;
  name: string;
  surface: string;
  platform: string;
  tokenHint: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string;
  capabilities: string[];
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string; capabilities: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/college/devices").then((x) => x.json());
      if (r.error) setErr(r.error);
      else setDevices(r.devices ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const mint = async (surface: string) => {
    const r = await fetch("/api/college/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pair_code", surface }),
    }).then((x) => x.json());
    if (r.error) setErr(r.error);
    else setCode(r);
  };

  const revoke = async (id: string) => {
    await fetch("/api/college/devices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, reason: "revoked from the Control Room" }),
    });
    await load();
  };

  const box = {
    background: "#111827",
    border: "1px solid #243044",
    borderRadius: 10,
    padding: "14px 16px",
  } as const;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#e2e8f0", maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <Link href="/college" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>
        ← College
      </Link>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginTop: 10 }}>Paired surfaces</h1>
      <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginTop: 6 }}>
        The College only speaks to devices paired from here. A phone is a <strong>Campus</strong> surface: it can read
        state, run sessions, record commitments and capture evidence. It can never edit curriculum, the timetable,
        faculty, or make institutional decisions — that ceiling is structural and cannot be granted per device.
      </p>

      {err && (
        <div style={{ ...box, borderColor: "#78350f", background: "#1a1408", marginTop: 16 }}>
          <div style={{ fontSize: 13, color: "#fca5a5" }}>{err}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
        <button
          onClick={() => mint("campus")}
          style={{ padding: "11px 16px", background: "#1d4ed8", border: "1px solid #2563eb", borderRadius: 9, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
        >
          Pair a phone (Campus)
        </button>
        <button
          onClick={() => mint("control_room")}
          style={{ padding: "11px 16px", background: "#111827", border: "1px solid #243044", borderRadius: 9, color: "#94a3b8", fontSize: 13.5, cursor: "pointer", fontFamily: "inherit" }}
        >
          Pair another Control Room
        </button>
      </div>

      {code && (
        <div style={{ ...box, marginTop: 16, borderColor: "#2563eb" }}>
          <div style={{ fontSize: 10, letterSpacing: 1.4, color: "#60a5fa", fontWeight: 700 }}>PAIRING CODE</div>
          <div style={{ fontSize: 34, letterSpacing: 6, fontWeight: 600, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
            {code.code}
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8, lineHeight: 1.55 }}>
            Type this into the device within ten minutes. It works once.
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
            grants: {code.capabilities.join(", ")}
          </div>
        </div>
      )}

      <div style={{ marginTop: 26 }}>
        {loading ? (
          <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>
        ) : devices.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: 13 }}>No devices are paired. The College is reachable only from this machine.</div>
        ) : (
          devices.map((d) => (
            <div key={d.id} style={{ ...box, marginTop: 10, opacity: d.revokedAt ? 0.55 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 500 }}>
                    {d.name}
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 400 }}> · {d.surface}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 3 }}>
                    {d.platform} · token {d.tokenHint} ·{" "}
                    {d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : "never used"}
                  </div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 5 }}>{d.capabilities.join(", ")}</div>
                  {d.revokedAt && (
                    <div style={{ fontSize: 11.5, color: "#fbbf24", marginTop: 5 }}>
                      revoked {new Date(d.revokedAt).toLocaleString()} — {d.revokedReason}
                    </div>
                  )}
                </div>
                {!d.revokedAt && (
                  <button
                    onClick={() => revoke(d.id)}
                    style={{ padding: "8px 12px", background: "#1a1408", border: "1px solid #78350f", borderRadius: 8, color: "#fbbf24", fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <p style={{ fontSize: 11, color: "#475569", marginTop: 24, lineHeight: 1.7 }}>
        Tokens are stored as hashes and cannot be shown again. A lost phone is handled by revoking, which takes effect on
        the next request. Revoked devices stay listed — which devices were trusted, and when that ended, is part of the
        record.
      </p>
    </div>
  );
}
