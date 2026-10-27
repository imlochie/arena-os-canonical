"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Subscriptions — the Bobby dupe: offline, private, unlimited (Bobby's paid
 * tier, free). Plus the Mailopoly hook: paste a receipt email and the app
 * extracts the subscription for one-tap saving.
 */

type Sub = {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  cadence: string;
  nextCharge: string;
  category: string;
  notes: string;
  active: boolean;
};

type Stats = { activeCount: number; monthlyCents: number; yearlyCents: number; upcoming: { id: string; name: string; amountCents: number; currency: string; nextCharge: string; daysAway: number }[] };

type EmailAccount = {
  id: string;
  address: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  lastScanAt: string | null;
  lastScanMessageCount: number | null;
  lastError: string | null;
};

type Candidate = {
  uid: number;
  subject: string;
  from: string;
  date: string | null;
  preview: string;
  alreadyTracked: boolean;
  extracted: { name: string; amountCents: number; currency: string; cadence: string; nextCharge: string; confidence: string };
};

const MAIL_PROVIDERS = [
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, note: "App Password required (2FA on)" },
  { id: "outlook", label: "Outlook", host: "outlook.office365.com", port: 993, note: "App Password required" },
  { id: "icloud", label: "iCloud", host: "imap.mail.me.com", port: 993, note: "App-Specific Password required" },
  { id: "fastmail", label: "Fastmail", host: "imap.fastmail.com", port: 993, note: "Use your app password" },
  { id: "custom", label: "Custom IMAP", host: "", port: 993, note: "Bring your own host/port" },
];

const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
const CATEGORY_COLORS = ["#818cf8", "#34d399", "#f472b6", "#fbbf24", "#38bdf8", "#a78bfa"];

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(cents / 100);

const input =
  "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none";
const button =
  "rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50";

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // form
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("monthly");
  const [nextCharge, setNextCharge] = useState("");
  const [category, setCategory] = useState("");
  // Mailopoly paste box
  const [emailText, setEmailText] = useState("");
  const [extracting, setExtracting] = useState(false);
  // Real inbox (IMAP)
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [presetId, setPresetId] = useState("gmail");
  const [mailAddress, setMailAddress] = useState("");
  const [mailUser, setMailUser] = useState("");
  const [mailPass, setMailPass] = useState("");
  const [mailHost, setMailHost] = useState("imap.gmail.com");
  const [mailPort, setMailPort] = useState(993);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{ address: string; scanned: number; candidates: Candidate[] } | null>(null);
  const [addedUids, setAddedUids] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/subscriptions");
      const data = await response.json();
      setSubs(data.subscriptions ?? []);
      setStats(data.stats ?? null);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(async () => {
    if (!name.trim() || !amount.trim() || !nextCharge || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, amount, currency, cadence, nextCharge, category }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setName("");
      setAmount("");
      setNextCharge("");
      setCategory("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [name, amount, currency, cadence, nextCharge, category, busy, refresh]);

  const extract = useCallback(async () => {
    if (!emailText.trim() || extracting) return;
    setExtracting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract",
          emailText,
          keys: {
            groq: localStorage.getItem("af_key_groq") || undefined,
            openai: localStorage.getItem("af_key_openai") || undefined,
            openrouter: localStorage.getItem("af_key_openrouter") || undefined,
            mistral: localStorage.getItem("af_key_mistral") || undefined,
          },
        }),
      });
      const data = await response.json();
      const extracted = data.extracted;
      if (!extracted || extracted.confidence === "none") {
        setMessage(extracted?.reason ?? "could not extract");
        return;
      }
      setName(extracted.name);
      setAmount((extracted.amountCents / 100).toFixed(2));
      setCurrency(extracted.currency ?? "USD");
      setCadence(extracted.cadence ?? "monthly");
      setNextCharge(extracted.nextCharge);
      setEmailText("");
      setMessage(`Extracted (via ${extracted.confidence}) — check the fields and hit Add.`);
    } finally {
      setExtracting(false);
    }
  }, [emailText, extracting]);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/email");
      const data = await response.json();
      setAccounts(data.accounts ?? []);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = MAIL_PROVIDERS.find((p) => p.id === id);
    if (preset) {
      setMailHost(preset.host);
      setMailPort(preset.port);
    }
  };

  const testConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          host: mailHost,
          port: mailPort,
          tls: true,
          username: mailUser || mailAddress,
          password: mailPass,
        }),
      });
      const data = await response.json();
      if (data.ok) {
        setTestResult(`✓ Logged in — ${data.mailboxes?.length ?? 0} mailboxes visible (${(data.mailboxes ?? []).slice(0, 5).join(", ")})`);
      } else {
        const hint = data.code === "auth_failed" ? " — server rejected the login; use an App Password, not your normal password" : "";
        setTestResult(`✗ ${data.code ?? "failed"}: ${String(data.detail ?? "").slice(0, 160)}${hint}`);
      }
    } catch (e) {
      setTestResult(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  }, [testing, mailHost, mailPort, mailUser, mailAddress, mailPass]);

  const saveAccount = useCallback(async () => {
    if (!mailAddress.trim() || !mailHost.trim() || !mailPass) return;
    setTestResult(null);
    try {
      const response = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          address: mailAddress,
          host: mailHost,
          port: mailPort,
          tls: true,
          username: mailUser || mailAddress,
          password: mailPass,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setTestResult(`✗ ${data.message ?? data.error ?? `HTTP ${response.status}`}`);
        return;
      }
      setMailPass("");
      setTestResult(`✓ ${data.account.address} saved (password sealed).`);
      await loadAccounts();
    } catch (e) {
      setTestResult(`✗ ${String(e)}`);
    }
  }, [mailAddress, mailHost, mailPort, mailUser, mailPass, loadAccounts]);

  const scanAccount = useCallback(
    async (account: EmailAccount) => {
      if (scanningId) return;
      setScanningId(account.id);
      setScanResult(null);
      setAddedUids([]);
      setTestResult(null);
      try {
        const response = await fetch("/api/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            id: account.id,
            days: 90,
            keys: {
              groq: localStorage.getItem("af_key_groq") || undefined,
              openai: localStorage.getItem("af_key_openai") || undefined,
              openrouter: localStorage.getItem("af_key_openrouter") || undefined,
              mistral: localStorage.getItem("af_key_mistral") || undefined,
            },
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const hint = data.error === "auth_failed" ? " (App Password?)" : "";
          setTestResult(`✗ Scan failed: ${data.error}${hint} — ${String(data.message ?? "").slice(0, 140)}`);
          return;
        }
        setScanResult({ address: account.address, scanned: data.scanned, candidates: data.candidates ?? [] });
      } catch (e) {
        setTestResult(`✗ ${String(e)}`);
      } finally {
        setScanningId(null);
      }
    },
    [scanningId],
  );

  const importCandidate = useCallback(
    async (candidate: Candidate) => {
      const key = `${scanResult?.address ?? ""}#${candidate.uid}`;
      if (addedUids.includes(key)) return;
      try {
        const response = await fetch("/api/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "import",
            name: candidate.extracted.name,
            amountCents: candidate.extracted.amountCents,
            currency: candidate.extracted.currency,
            cadence: candidate.extracted.cadence,
            nextCharge: candidate.extracted.nextCharge,
            notes: `From email scan: “${candidate.subject}”`,
          }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setTestResult(`✗ Could not add: ${data.message ?? data.error ?? response.status}`);
          return;
        }
        setAddedUids((list) => [...list, key]);
        refresh();
      } catch (e) {
        setTestResult(`✗ ${String(e)}`);
      }
    },
    [addedUids, scanResult, refresh],
  );

  const removeAccount = useCallback(
    async (id: string) => {
      setAccounts((list) => list.filter((a) => a.id !== id));
      await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      loadAccounts();
    },
    [loadAccounts],
  );

  const toggleActive = useCallback(
    async (sub: Sub) => {      setSubs((list) => list.map((s) => (s.id === sub.id ? { ...s, active: !s.active } : s)));
      await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id: sub.id, active: !sub.active }),
      });
      refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setSubs((list) => list.filter((s) => s.id !== id));
      await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      refresh();
    },
    [refresh],
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black text-white">Subscriptions</h1>
      <p className="mt-2 text-sm text-slate-400">
        Offline, private, unlimited — everything Bobby charges for, free. Paste a receipt email below and the fields fill themselves.
      </p>

      {stats && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">per month</p>
            <p className="mt-1 text-2xl font-black text-white">{money(stats.monthlyCents, "USD")}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">per year</p>
            <p className="mt-1 text-2xl font-black text-white">{money(stats.yearlyCents, "USD")}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">active</p>
            <p className="mt-1 text-2xl font-black text-white">{stats.activeCount}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">next 30 days</p>
            <p className="mt-1 text-2xl font-black text-white">{stats.upcoming.length}</p>
          </div>
        </div>
      )}

      {stats && stats.upcoming.length > 0 && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-300">Coming up</p>
          <ul className="mt-2 space-y-1 text-sm">
            {stats.upcoming.slice(0, 6).map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-slate-300">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${item.daysAway <= 3 ? "bg-rose-500/20 text-rose-300" : "bg-white/10 text-slate-400"}`}>
                  {item.daysAway <= 0 ? "today" : `${item.daysAway}d`}
                </span>
                {item.name} — {money(item.amountCents, item.currency)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-bold text-white">Add one</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (Netflix…)" />
          <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (12.99)" />
          <div className="flex gap-2">
            <select className={input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["USD", "SGD", "AUD", "EUR", "GBP", "JPY"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select className={input} value={cadence} onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <input className={input} type="date" value={nextCharge} onChange={(e) => setNextCharge(e.target.value)} />
          <input className={`${input} sm:col-span-2`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category (streaming, tools… optional)" />
        </div>
        <button className={`${button} mt-3`} onClick={add} disabled={busy || !name.trim() || !amount.trim() || !nextCharge}>
          Add subscription
        </button>
        {message && <p className="mt-2 text-xs text-violet-300">{message}</p>}

        <details className="mt-5">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-400">📎 Paste a receipt email instead (Mailopoly-style)</summary>
          <textarea
            className={`${input} mt-2 h-28`}
            value={emailText}
            onChange={(e) => setEmailText(e.target.value)}
            placeholder="Paste the receipt / invoice / subscription confirmation email text…"
          />
          <button className={`${button} mt-2`} onClick={extract} disabled={extracting || !emailText.trim()}>
            {extracting ? "Reading…" : "Extract fields"}
          </button>
        </details>
      </div>

      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-bold text-white">📬 Log into your email</h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          Connect your mailbox over IMAP and scan it for subscription receipts — the Mailopoly inbox, but your data stays on this machine.
          Credentials are sealed (AES-256-GCM) in your local database. Gmail, Outlook and iCloud require an <strong>App Password</strong>, not your normal login.
        </p>

        {accounts.length > 0 && (
          <ul className="mt-3 space-y-2">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-400/15 bg-emerald-400/5 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-white">{account.address}</p>
                  <p className="text-[11px] text-slate-400">
                    {account.host}:{account.port}
                    {account.lastScanAt
                      ? ` · last scan ${new Date(account.lastScanAt).toLocaleDateString()} (${account.lastScanMessageCount ?? 0} messages)`
                      : " · never scanned"}
                    {account.lastError ? ` · ⚠ ${account.lastError.slice(0, 60)}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    onClick={() => void scanAccount(account)}
                    disabled={scanningId !== null}
                  >
                    {scanningId === account.id ? "Scanning…" : "Scan for receipts"}
                  </button>
                  <button
                    className="rounded-lg border border-rose-500/30 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                    onClick={() => void removeAccount(account.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-400">
            {accounts.length ? "Add another mailbox" : "Connect a mailbox"}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select className={input} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
              {MAIL_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <input className={input} value={mailAddress} onChange={(e) => setMailAddress(e.target.value)} placeholder="you@gmail.com" />
            <input className={input} value={mailUser} onChange={(e) => setMailUser(e.target.value)} placeholder={`Username (default: the address)`} />
            <input className={input} type="password" value={mailPass} onChange={(e) => setMailPass(e.target.value)} placeholder="App password" />
            <input className={input} value={mailHost} onChange={(e) => setMailHost(e.target.value)} placeholder="IMAP host" disabled={presetId !== "custom"} />
            <input className={input} type="number" value={mailPort} onChange={(e) => setMailPort(Number(e.target.value) || 993)} disabled={presetId !== "custom"} />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">{MAIL_PROVIDERS.find((p) => p.id === presetId)?.note}</p>
          <div className="mt-2 flex gap-2">
            <button className={`${button}`} onClick={() => void testConnection()} disabled={testing || !mailHost.trim() || !(mailUser || mailAddress) || !mailPass}>
              {testing ? "Knocking…" : "Test login"}
            </button>
            <button
              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
              onClick={() => void saveAccount()}
              disabled={!mailAddress.trim() || !mailHost.trim() || !mailPass}
            >
              Save account
            </button>
          </div>
        </details>

        {testResult && <p className="mt-2 break-words text-xs text-violet-300">{testResult}</p>}

        {scanResult && (
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              {scanResult.address} — scanned {scanResult.scanned} messages, found {scanResult.candidates.length} receipt{scanResult.candidates.length === 1 ? "" : "s"}
            </p>
            <ul className="mt-2 space-y-2">
              {scanResult.candidates.map((candidate) => {
                const key = `${scanResult.address}#${candidate.uid}`;
                const added = addedUids.includes(key);
                return (
                  <li key={key} className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">{candidate.subject || "(no subject)"}</p>
                      <span className="text-[11px] text-slate-500">{candidate.date ? new Date(candidate.date).toLocaleDateString() : ""}</span>
                    </div>
                    <p className="truncate text-[11px] text-slate-500">{candidate.from}</p>
                    <p className="mt-1 text-sm text-slate-200">
                      <span className="font-bold">{candidate.extracted.name}</span> — {money(candidate.extracted.amountCents, candidate.extracted.currency)} / {candidate.extracted.cadence}, next {candidate.extracted.nextCharge}
                      <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{candidate.extracted.confidence}</span>
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      {added || candidate.alreadyTracked ? (
                        <span className="rounded-lg bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300">
                          {added ? "Added ✓" : "Already tracked"}
                        </span>
                      ) : (
                        <button
                          className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500"
                          onClick={() => void importCandidate(candidate)}
                        >
                          Add subscription
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
              {scanResult.candidates.length === 0 && (
                <li className="py-6 text-center text-sm text-slate-500">No subscription receipts found in the last 90 days.</li>
              )}
            </ul>
          </div>
        )}
      </div>

      <ul className="mt-6 space-y-2">
        {subs.map((sub) => (
          <li key={sub.id} className={`flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 ${sub.active ? "" : "opacity-50"}`}>
            <span className="h-3 w-3 rounded-full" style={{ background: CATEGORY_COLORS[sub.category.length % CATEGORY_COLORS.length] }} />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-white">{sub.name}</p>
              <p className="text-[11px] text-slate-400">
                {money(sub.amountCents, sub.currency)} / {sub.cadence} · next {sub.nextCharge}
                {sub.category ? ` · ${sub.category}` : ""}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button className="rounded-lg border border-white/15 px-3 py-1 text-xs text-slate-300 hover:text-white" onClick={() => void toggleActive(sub)}>
                {sub.active ? "Pause" : "Resume"}
              </button>
              <button className="rounded-lg border border-rose-500/30 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10" onClick={() => void remove(sub.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
        {subs.length === 0 && <li className="py-10 text-center text-sm text-slate-500">Nothing tracked yet.</li>}
      </ul>
    </main>
  );
}
