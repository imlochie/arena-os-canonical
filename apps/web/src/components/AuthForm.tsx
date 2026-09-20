"use client";
import { FormEvent, useState } from "react";

export function AuthForm() {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    const form = new FormData(event.currentTarget);
    const body = mode === "register" ? { username: form.get("username"), displayName: form.get("displayName"), email: form.get("email"), password: form.get("password") } : { identity: form.get("identity"), password: form.get("password") };
    const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) return setMessage(json.error ?? "Account action failed.");
    window.location.assign("/create");
  }
  return <form className="form" onSubmit={submit}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><b>{mode === "register" ? "Start a private studio" : "Sign in to your studio"}</b><button type="button" className="button secondary" style={{ padding: "6px 9px" }} onClick={() => setMode(mode === "register" ? "login" : "register")}>{mode === "register" ? "I have an account" : "Create account"}</button></div>
    {mode === "register" && <><label>Username<input name="username" required pattern="[a-zA-Z0-9_-]{3,32}" autoComplete="username" /></label><label>Display name<input name="displayName" required maxLength={80} autoComplete="name" /></label></>}
    <label>{mode === "register" ? "Email" : "Email or username"}<input name={mode === "register" ? "email" : "identity"} required autoComplete={mode === "register" ? "email" : "username"} /></label>
    <label>Password<input name="password" required type="password" minLength={mode === "register" ? 12 : 1} autoComplete={mode === "register" ? "new-password" : "current-password"} /></label>
    {message && <p className="error" role="alert">{message}</p>}<button className="button" disabled={busy}>{busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}</button>
  </form>;
}
