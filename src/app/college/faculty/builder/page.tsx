"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface Member {
  id: string;
  name: string;
  positionKey: string;
  status: string;
  version: number;
  temperament: string;
  communicationStyle: string;
  teachingStyle: string;
  questioningStyle: string;
  directness: number;
  warmth: number;
  formality: number;
  ambiguityTolerance: number;
  personalityInstruction: string;
  responsibilities: string;
  grantedAuthority: string;
  mandatoryLevel: string;
  missingSeverity: string;
  activatesOnEvents: string;
  activatesOnPhases: string;
  canConsult: string;
  canHandOffTo: string;
  canInterrupt: boolean;
  notes: string;
}

interface Position {
  key: string;
  name: string;
  emoji: string;
  branch: string;
  question: string;
  ceiling: string[];
  responsibilities: { key: string; label: string; description: string; cannot: string[] }[];
}

interface Preset {
  key: string;
  name: string;
  positionKey: string;
  temperament: string;
  personalityInstruction: string;
}

interface Authority {
  key: string;
  label: string;
  description: string;
  protected: boolean;
}

const parse = (s: string): string[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const MANDATORY_HELP: Record<string, string> = {
  college_wide: "Required in every session the College runs.",
  course: "Required in every session of the assigned course.",
  session_type: "Required for a specific kind of session.",
  phase: "Required during a specific phase of a session.",
  conditional: "Required only when its activation conditions are met.",
  optional: "Participates when configured, but nothing blocks without it.",
};

export default function FacultyBuilderPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [mandatoryLevels, setMandatoryLevels] = useState<string[]>([]);
  const [selected, setSelected] = useState<Member | null>(null);
  const [draft, setDraft] = useState<Partial<Member>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async (keepId?: string) => {
    const r = await fetch(`/api/college/members${showArchived ? "?includeArchived=1" : ""}`);
    const d = await r.json();
    setMembers(d.members ?? []);
    setPositions(d.positions ?? []);
    setPresets(d.presets ?? []);
    setAuthorities(d.authorities ?? []);
    setMandatoryLevels(d.mandatoryLevels ?? []);
    if (keepId) {
      const m = (d.members ?? []).find((x: Member) => x.id === keepId);
      if (m) {
        setSelected(m);
        setDraft(m);
      }
    }
    setLoading(false);
  }, [showArchived]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function pick(m: Member) {
    setSelected(m);
    setDraft(m);
    setWarnings([]);
    setNote("");
  }

  const position = positions.find((p) => p.key === (draft.positionKey ?? selected?.positionKey));

  async function save() {
    if (!selected) return;
    const reason = window.prompt("Why is this configuration changing?\n\nThe previous version is preserved.");
    if (!reason) return;
    setBusy(true);
    const r = await fetch("/api/college/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        id: selected.id,
        responsibilities: parse(String(draft.responsibilities ?? "[]")),
        grantedAuthority: parse(String(draft.grantedAuthority ?? "[]")),
        activatesOnEvents: parse(String(draft.activatesOnEvents ?? "[]")),
        activatesOnPhases: parse(String(draft.activatesOnPhases ?? "[]")),
        canConsult: parse(String(draft.canConsult ?? "[]")),
        canHandOffTo: parse(String(draft.canHandOffTo ?? "[]")),
        reason,
      }),
    });
    const d = await r.json();
    setWarnings(d.warnings ?? []);
    setNote(d.note ?? d.error ?? "");
    setBusy(false);
    await load(selected.id);
  }

  async function fromPreset(key: string) {
    setBusy(true);
    const r = await fetch("/api/college/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "from_preset", presetKey: key }),
    });
    const d = await r.json();
    setBusy(false);
    setNote(d.note ?? d.error ?? "");
    await load(d.member?.id);
  }

  async function setStatus(status: string) {
    if (!selected) return;
    const reason = window.prompt(`Why is ${selected.name} becoming ${status}?`);
    if (!reason) return;
    setBusy(true);
    const r = await fetch("/api/college/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selected.id, status, reason }),
    });
    const d = await r.json();
    setNote(d.note ?? d.error ?? "");
    setBusy(false);
    await load(selected.id);
  }

  function toggleIn(field: keyof Member, value: string) {
    const cur = parse(String(draft[field] ?? "[]"));
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    setDraft({ ...draft, [field]: JSON.stringify(next) });
  }

  if (loading) return <div style={{ padding: 40, color: "#94a3b8", fontFamily: "system-ui" }}>Loading faculty…</div>;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0b0f17", minHeight: "100vh", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "26px 22px 70px" }}>
        <Link href="/college/faculty" style={{ color: "#64748b", fontSize: 12, textDecoration: "none" }}>← Faculty</Link>
        <h1 style={{ fontSize: 24, margin: "6px 0 4px", letterSpacing: -0.4 }}>Faculty Builder</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 22px", maxWidth: 720, lineHeight: 1.6 }}>
          A <strong style={{ color: "#94a3b8" }}>position</strong> is an institutional responsibility and carries the
          authority. A <strong style={{ color: "#94a3b8" }}>member</strong> is a configured personality that occupies it.
          Personality never grants authority.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
          {/* ---- roster ---- */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
              <div style={{ fontSize: 11, letterSpacing: 1.4, color: "#64748b", fontWeight: 700 }}>MEMBERS</div>
              <label style={{ fontSize: 10.5, color: "#64748b", display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                archived
              </label>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {members.map((m) => {
                const pos = positions.find((p) => p.key === m.positionKey);
                const on = selected?.id === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => pick(m)}
                    style={{
                      textAlign: "left", padding: "9px 11px", borderRadius: 8, cursor: "pointer",
                      background: on ? "#182236" : "#0f1420",
                      border: `1px solid ${on ? "#2563eb" : "#1e2637"}`,
                      color: "inherit", fontFamily: "inherit",
                      opacity: m.status === "active" ? 1 : 0.5,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 620 }}>
                      {pos?.emoji} {m.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 2 }}>
                      {pos?.name ?? m.positionKey} · v{m.version}
                      {m.status !== "active" && ` · ${m.status}`}
                    </div>
                    {m.mandatoryLevel !== "optional" && (
                      <div style={{ fontSize: 10, color: "#fcd34d", marginTop: 2 }}>
                        {m.mandatoryLevel.replace(/_/g, " ")}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            <div style={{ fontSize: 11, letterSpacing: 1.4, color: "#64748b", fontWeight: 700, margin: "20px 0 9px" }}>
              ADD FROM PRESET
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {presets.map((p) => (
                <button
                  key={p.key}
                  disabled={busy}
                  onClick={() => fromPreset(p.key)}
                  style={{
                    textAlign: "left", padding: "7px 10px", borderRadius: 7, cursor: "pointer",
                    background: "#0d1119", border: "1px dashed #243044", color: "#94a3b8",
                    fontSize: 12, fontFamily: "inherit",
                  }}
                >
                  + {p.name}
                  <span style={{ color: "#475569", fontSize: 10.5 }}> · {p.positionKey}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ---- editor ---- */}
          <div>
            {!selected && (
              <div style={{ padding: 30, background: "#0f1420", border: "1px dashed #243044", borderRadius: 11, color: "#64748b", fontSize: 13.5, lineHeight: 1.6 }}>
                Select a member to configure, or create one from a preset. Presets are starting points —
                everything about them is editable.
              </div>
            )}

            {selected && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {(note || warnings.length > 0) && (
                  <div style={{ padding: "12px 14px", background: warnings.length ? "#2b2417" : "#14243a", border: `1px solid ${warnings.length ? "#d97706" : "#2563eb"}`, borderRadius: 9, fontSize: 12.5, lineHeight: 1.6 }}>
                    {note && <div style={{ color: warnings.length ? "#fcd34d" : "#bfdbfe", marginBottom: warnings.length ? 8 : 0 }}>{note}</div>}
                    {warnings.map((w, i) => (
                      <div key={i} style={{ color: "#fcd34d", marginTop: 4 }}>⚠ {w}</div>
                    ))}
                  </div>
                )}

                <Card title="IDENTITY">
                  <Row label="Name">
                    <input
                      value={draft.name ?? ""}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      style={inp}
                    />
                  </Row>
                  <Row label="Position">
                    <div style={{ fontSize: 13, color: "#cbd5e1" }}>
                      {position?.emoji} {position?.name}
                      <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, fontStyle: "italic" }}>
                        &ldquo;{position?.question}&rdquo;
                      </div>
                      <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>
                        Branch: {position?.branch} · version {selected.version} · status {selected.status}
                      </div>
                    </div>
                  </Row>
                </Card>

                <Card title="PERSONALITY" hint="How this member sounds. Never what it is allowed to do.">
                  <Row label="Temperament">
                    <input value={draft.temperament ?? ""} onChange={(e) => setDraft({ ...draft, temperament: e.target.value })} style={inp} />
                  </Row>
                  <Row label="Teaching style">
                    <input value={draft.teachingStyle ?? ""} onChange={(e) => setDraft({ ...draft, teachingStyle: e.target.value })} style={inp} />
                  </Row>
                  <Row label="Questioning">
                    <input value={draft.questioningStyle ?? ""} onChange={(e) => setDraft({ ...draft, questioningStyle: e.target.value })} style={inp} />
                  </Row>
                  {(["directness", "warmth", "formality", "ambiguityTolerance"] as const).map((k) => (
                    <Row key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input
                          type="range" min={1} max={5}
                          value={Number(draft[k] ?? 3)}
                          onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
                          style={{ flex: 1 }}
                        />
                        <span style={{ fontSize: 12, color: "#94a3b8", width: 14 }}>{Number(draft[k] ?? 3)}</span>
                      </div>
                    </Row>
                  ))}
                  <Row label="Instruction">
                    <textarea
                      value={draft.personalityInstruction ?? ""}
                      onChange={(e) => setDraft({ ...draft, personalityInstruction: e.target.value })}
                      rows={5}
                      style={{ ...inp, fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.55, resize: "vertical" }}
                    />
                    <div style={{ fontSize: 10.5, color: "#475569", marginTop: 5, lineHeight: 1.5 }}>
                      Real instruction text, not adjectives. Claims to authority written here are detected and
                      refused — institutional rules outrank personality.
                    </div>
                  </Row>
                </Card>

                <Card title="AUTHORITY" hint="Bounded by the position. Protected powers can never be granted.">
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {authorities.map((a) => {
                      const allowed = position?.ceiling.includes(a.key) ?? false;
                      const has = parse(String(draft.grantedAuthority ?? "[]")).includes(a.key);
                      return (
                        <label
                          key={a.key}
                          style={{
                            display: "flex", gap: 9, alignItems: "flex-start", padding: "7px 9px",
                            borderRadius: 7, background: has ? "#13202e" : "transparent",
                            border: `1px solid ${has ? "#1d4ed8" : "#161d29"}`,
                            cursor: allowed && !a.protected ? "pointer" : "not-allowed",
                            opacity: allowed && !a.protected ? 1 : 0.42,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={has}
                            disabled={!allowed || a.protected}
                            onChange={() => toggleIn("grantedAuthority", a.key)}
                            style={{ marginTop: 2 }}
                          />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                              {a.label}
                              {a.protected && <span style={{ color: "#f87171", fontSize: 10, marginLeft: 7 }}>PROTECTED</span>}
                              {!allowed && !a.protected && <span style={{ color: "#64748b", fontSize: 10, marginLeft: 7 }}>OUTSIDE THIS POSITION</span>}
                            </div>
                            <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 2, lineHeight: 1.45 }}>{a.description}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </Card>

                <Card title="RESPONSIBILITIES" hint="What this position is accountable for — and explicitly cannot do.">
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(position?.responsibilities ?? []).map((r) => {
                      const has = parse(String(draft.responsibilities ?? "[]")).includes(r.key);
                      return (
                        <label key={r.key} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "7px 9px", borderRadius: 7, background: has ? "#13202e" : "transparent", border: `1px solid ${has ? "#1d4ed8" : "#161d29"}`, cursor: "pointer" }}>
                          <input type="checkbox" checked={has} onChange={() => toggleIn("responsibilities", r.key)} style={{ marginTop: 2 }} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.label}</div>
                            <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 2, lineHeight: 1.45 }}>{r.description}</div>
                            {r.cannot.length > 0 && (
                              <div style={{ fontSize: 10.5, color: "#f87171", marginTop: 3, lineHeight: 1.45 }}>
                                Cannot: {r.cannot.join(" · ")}
                              </div>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </Card>

                <Card title="PARTICIPATION" hint="Mandatory means the responsibility cannot be omitted — not that the member always speaks.">
                  <Row label="Mandatory level">
                    <select
                      value={draft.mandatoryLevel ?? "optional"}
                      onChange={(e) => setDraft({ ...draft, mandatoryLevel: e.target.value })}
                      style={inp}
                    >
                      {mandatoryLevels.map((l) => <option key={l} value={l}>{l.replace(/_/g, " ")}</option>)}
                    </select>
                    <div style={{ fontSize: 10.5, color: "#475569", marginTop: 5 }}>
                      {MANDATORY_HELP[draft.mandatoryLevel ?? "optional"] ?? ""}
                    </div>
                  </Row>
                  <Row label="If uninstantiable">
                    <select
                      value={draft.missingSeverity ?? "warn"}
                      onChange={(e) => setDraft({ ...draft, missingSeverity: e.target.value })}
                      style={inp}
                    >
                      <option value="warn">warn — the session may still open</option>
                      <option value="block">block — the session cannot fully initialise</option>
                    </select>
                  </Row>
                  <Row label="Can interrupt">
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "#cbd5e1", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={draft.canInterrupt === true}
                        onChange={(e) => setDraft({ ...draft, canInterrupt: e.target.checked })}
                      />
                      may interrupt the instructor mid-explanation
                    </label>
                  </Row>
                </Card>

                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button
                    onClick={save}
                    disabled={busy}
                    style={{ padding: "10px 20px", background: "#2563eb", border: "none", borderRadius: 8, color: "white", fontWeight: 650, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    {busy ? "Saving…" : "Save configuration"}
                  </button>
                  {selected.status === "active" ? (
                    <button onClick={() => setStatus("inactive")} disabled={busy} style={btnGhost}>Deactivate</button>
                  ) : (
                    <button onClick={() => setStatus("active")} disabled={busy} style={btnGhost}>Reactivate</button>
                  )}
                  <button onClick={() => setStatus("archived")} disabled={busy} style={btnGhost}>Archive</button>
                </div>
                <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.6 }}>
                  Faculty members are never deleted. Historical sessions keep the member and the exact
                  configuration version that applied when they ran.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", background: "#0b0f17", border: "1px solid #243044",
  borderRadius: 7, color: "#e2e8f0", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

const btnGhost: React.CSSProperties = {
  padding: "10px 16px", background: "#161b26", border: "1px solid #243044", borderRadius: 8,
  color: "#94a3b8", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0f1420", border: "1px solid #1e2637", borderRadius: 11, padding: "16px 18px" }}>
      <div style={{ fontSize: 11, letterSpacing: 1.4, color: "#64748b", fontWeight: 700 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: "#475569", marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
      <div style={{ marginTop: 13, display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "128px 1fr", gap: 12, alignItems: "start" }}>
      <div style={{ fontSize: 11.5, color: "#64748b", paddingTop: 8 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}
