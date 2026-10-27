"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * THE GOVERNANCE QUEUE
 *
 * Everything that requires an institutional decision, in one place, phrased
 * the same way: WHAT · WHY · EVIDENCE · SOURCE · IMPACT · AUTHORITY REQUIRED.
 *
 * Nothing on this page changes anything. Acting on an item means going to the
 * surface that owns it, where the act is explicit and recorded.
 */

interface Item {
  id: string;
  kind: string;
  what: string;
  why: string;
  evidence: string[];
  source: string;
  impact: string;
  authorityRequired: string;
  actionPath: string;
  raisedOn: string | null;
  informationalOnly: boolean;
}

const KIND_LABEL: Record<string, { label: string; color: string }> = {
  curriculum_change_proposed: { label: "Curriculum change proposed", color: "#a855f7" },
  timetable_change_proposed: { label: "Timetable mismatch", color: "#f59e0b" },
  faculty_change_proposed: { label: "Faculty change proposed", color: "#06b6d4" },
  source_conflict_requires_decision: { label: "Source conflict", color: "#ef4444" },
  memory_promotion_requires_review: { label: "Memory promotion", color: "#3b82f6" },
  audit_review_signal: { label: "Audit review signal", color: "#64748b" },
};

export default function GovernancePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState("");
  const [counts, setCounts] = useState({ actionable: 0, informational: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/college/governance");
        const d = await r.json();
        if (cancelled) return;
        setItems(d.items ?? []);
        setNote(d.note ?? "");
        setCounts({ actionable: d.actionable ?? 0, informational: d.informational ?? 0 });
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const actionable = items.filter((i) => !i.informationalOnly);
  const informational = items.filter((i) => i.informationalOnly);

  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-8 text-slate-200">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">Governance</h1>
            <Link href="/college" className="text-[12px] text-slate-500 hover:text-slate-300">
              ← College
            </Link>
            <Link href="/college/inspector" className="text-[12px] text-slate-500 hover:text-slate-300">
              Inspector
            </Link>
          </div>
          <p className="mt-1 text-[13px] text-slate-500">
            Everything awaiting an institutional decision. Nothing here has changed anything, and
            nothing will until you decide it should.
          </p>
        </header>

        {loading ? (
          <div className="rounded-xl border border-slate-800 bg-[#0d0d14] p-8 text-center text-[13px] text-slate-600">
            Loading…
          </div>
        ) : !items.length ? (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-8 text-center">
            <div className="text-[15px] font-semibold text-emerald-300">NO CHANGE INDICATED</div>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-400">
              Nothing requires an institutional decision. Leave the functioning system alone.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex gap-3 text-[12px]">
              <span className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-1.5">
                <span className="font-semibold text-white">{counts.actionable}</span>{" "}
                <span className="text-slate-400">awaiting decision</span>
              </span>
              <span className="rounded-lg border border-slate-800 px-3 py-1.5 text-slate-500">
                {counts.informational} informational
              </span>
            </div>

            {actionable.length > 0 && (
              <section className="mb-6 space-y-3">
                {actionable.map((i) => (
                  <ItemCard key={i.id} item={i} />
                ))}
              </section>
            )}

            {informational.length > 0 && (
              <section>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  Informational — a request to look, not a request to act
                </div>
                <div className="space-y-3">
                  {informational.map((i) => (
                    <ItemCard key={i.id} item={i} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {note && <p className="mt-5 text-[11px] leading-relaxed text-slate-600">{note}</p>}
      </div>
    </div>
  );
}

function ItemCard({ item }: { item: Item }) {
  const kind = KIND_LABEL[item.kind] ?? { label: item.kind, color: "#64748b" };
  return (
    <article
      className={`rounded-xl border bg-[#0d0d14] p-4 ${
        item.informationalOnly ? "border-slate-800" : "border-slate-700"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{ background: `${kind.color}22`, color: kind.color }}
        >
          {kind.label}
        </span>
        {item.raisedOn && <span className="text-[10px] text-slate-600">{item.raisedOn}</span>}
      </div>

      <h2 className="text-[14px] font-semibold leading-snug text-slate-100">{item.what}</h2>

      <dl className="mt-3 space-y-2 text-[12px]">
        <Row label="Why">{item.why}</Row>
        {item.evidence.length > 0 && (
          <Row label="Evidence">
            <ul className="space-y-0.5">
              {item.evidence.map((e, i) => (
                <li key={i} className="text-slate-400">
                  · {e}
                </li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="Source">{item.source}</Row>
        <Row label="Impact">{item.impact}</Row>
        <Row label="Authority">
          <span className="font-medium text-slate-300">
            {item.authorityRequired === "founder"
              ? "The founder decides."
              : item.authorityRequired === "institutional_authority"
                ? "Institutional authority required."
                : item.authorityRequired === "administration"
                  ? "Administration."
                  : "No decision required."}
          </span>
        </Row>
      </dl>

      <div className="mt-3">
        <Link
          href={item.actionPath}
          className="inline-block rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
        >
          Go to where this is decided →
        </Link>
      </div>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_1fr] gap-2">
      <dt className="text-[10px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="text-slate-400">{children}</dd>
    </div>
  );
}
