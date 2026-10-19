"use client";
import { useRef, useState } from "react";
type Entry = { id: string; sha256?: string; bytes: number; modifiedAt: string; state: string; references: number; referenceKinds?: string[] };
type Operation = { id: string; sha256: string; state: string; reason: string; notBefore: string; purgeAfter?: string; audit: Array<{ at: string; event: string }> };
type Report = { mayMark: boolean; reasons: string[]; notice: string };
export function ArtifactStorageRecovery({ onChange }: { onChange: () => Promise<void> }) {
  const [entries, setEntries] = useState<Entry[] | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [enabled, setEnabled] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]), [reports, setReports] = useState<Record<string, Report>>({});
  const identities = useRef(new Map<string, string>());
  async function post(body: unknown) {
    const response = await fetch("/api/artifacts/storage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Storage operation not acknowledged. Inspect the audit before retrying."); return data;
  }
  async function inspect() {
    setBusy(true);
    try {
      const response = await fetch("/api/artifacts/storage"), data = await response.json(); if (!response.ok) throw new Error(data.error);
      setEntries(data.objects); setNotice(data.policy + (data.truncated ? " Showing the first500 objects." : ""));
      const cleanup = await fetch("/api/artifacts/storage?reclamation=1"), ledger = await cleanup.json(); if (!cleanup.ok) throw new Error(ledger.error);
      setOperations(ledger.operations); setEnabled(ledger.policy.enabled);
      for (const operation of ledger.operations as Operation[]) { if (operation.state === "marked") identities.current.set(operation.sha256, operation.id); else if (identities.current.get(operation.sha256) === operation.id) identities.current.delete(operation.sha256); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Storage inventory unavailable."); } finally { setBusy(false); }
  }
  async function recover(sha256: string) {
    setBusy(true);
    try { await post({ sha256 }); await onChange(); await inspect(); setNotice("Verified content recovered as an immutable Artifact. Its original operation was NOT replayed; origin is explicitly marked recovered/unknown."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Recovery not acknowledged; inspect the Library before retrying."); } finally { setBusy(false); }
  }
  async function report(sha256: string) {
    setBusy(true); try { const data = await post({ action: "report", sha256 }); setReports(current => ({ ...current, [sha256]: data })); setNotice(data.notice); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Dry-run unavailable. Nothing was acknowledged."); } finally { setBusy(false); }
  }
  async function mark(sha256: string) {
    if (!confirm("Abandon recovery of these exact unreferenced bytes? Marking does not delete them. History, Missions, pending work, age and grace checks still apply. Recover useful work as an Artifact instead.")) return;
    const id = identities.current.get(sha256) ?? crypto.randomUUID(); identities.current.set(sha256, id);
    setBusy(true); try { await post({ action: "mark", id, sha256, abandonRecovery: true }); await inspect(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Mark not acknowledged. Retry the same operation."); } finally { setBusy(false); }
  }
  async function action(operation: Operation, action: "sweep" | "purge" | "restore", execute = false) {
    if (execute && !confirm(action === "purge" ? "Permanently remove quarantined bytes after a fresh graph and integrity check? After purge only an external backup can restore them." : "Move verified unreferenced bytes into recoverable quarantine after fresh reference checks?")) return;
    setBusy(true); try {
      const data = await post({ action, id: operation.id, execute }); await inspect();
      setNotice(data.operation.dryRun ? `Dry run only. Current blockers: ${data.operation.blockers.join("; ") || "none; age, grace and identity checks still apply during execution"}` : data.operation.reason);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Operation not acknowledged. Inspect audit before retrying."); } finally { setBusy(false); }
  }
  return <section aria-label="Retained content recovery" className="mb-4 rounded-xl border border-white/10 p-3 text-xs">
    <button disabled={busy} onClick={() => void inspect()}>Inspect retained private content</button>
    {notice && <p role="status" className="my-2">{notice}</p>}
    {entries && <p>Cleanup execution {enabled ? "explicitly enabled by the operator; every request still requires checks and confirmation" : "disabled by default"}. Inspection never marks or deletes bytes. Current/history/pins and uncertain work are retained.</p>}
    {entries?.map(entry => <div key={entry.id} className="my-2 break-all border-t border-white/10 pt-2">
      <code>{entry.sha256 ?? "Incomplete unpublished write"}</code> · {entry.bytes.toLocaleString()} bytes · {entry.state} · {entry.references} retained graph references{entry.referenceKinds?.length ? ` (${entry.referenceKinds.join(", ")})` : ""} · {entry.modifiedAt}
      {entry.state === "uncertain" && <p>Metadata disagreement or missing immutable baseline — bytes retained. Reconcile the database/history before any disposal decision.</p>}
      {entry.state === "unbound" && entry.sha256 && <div>
        <a href={`/api/artifacts/storage?sha=${entry.sha256}`}>Download and verify retained bytes</a>{" · "}
        <button disabled={busy} onClick={() => void recover(entry.sha256!)}>Recover as Artifact (unknown origin)</button>{" · "}
        <button disabled={busy} onClick={() => void report(entry.sha256!)}>Dry-run cleanup eligibility</button>
        {reports[entry.sha256] && <p>{reports[entry.sha256].reasons.join("; ") || "No current blockers found. Explicit abandonment and separate grace periods are still required."}</p>}
        {reports[entry.sha256]?.mayMark && <button disabled={busy} onClick={() => void mark(entry.sha256!)}>Mark abandoned bytes (no deletion)</button>}
      </div>}
    </div>)}
    {operations.length > 0 && <h4>Cleanup audit and recovery</h4>}
    {operations.map(operation => <article key={operation.id} aria-label={`Cleanup ${operation.id}`} className="my-2 border-t border-white/10 pt-2">
      <p>{operation.sha256} · {operation.state} · {operation.reason}</p>
      <p>Mark grace until {operation.notBefore}{operation.purgeAfter ? ` · quarantine retained until at least ${operation.purgeAfter}` : ""}</p>
      <button disabled={busy} onClick={() => void action(operation, "sweep")}>Dry-run sweep</button>{" · "}
      {["marked", "quarantining"].includes(operation.state) && <button disabled={busy || !enabled} onClick={() => void action(operation, "sweep", true)}>Quarantine abandoned bytes</button>}
      {["quarantined", "quarantining", "purging"].includes(operation.state) && <>
        <a href={`/api/artifacts/storage?reclamationDownload=${operation.id}`}>Download retained quarantine</a>{" · "}
        <button disabled={busy} onClick={() => void action(operation, "restore")}>Restore retained bytes</button>{" · "}
        <button disabled={busy || !enabled} onClick={() => void action(operation, "purge", true)}>Permanently reclaim after grace</button>
      </>}
      <details><summary>Inspect cleanup audit</summary>{operation.audit.map((event, index) => <p key={index}>{event.at} · {event.event}</p>)}</details>
    </article>)}
  </section>;
}
