/**
 * App Foundry — vibe coding for a local-first app (Bolt.new / Lovable / v0 /
 * Base44 of the vibe-tools list, done Arena-style): describe an app in plain
 * language, any model in the app generates it, you preview it in a sandboxed
 * iframe and iterate version by version.
 *
 * Honesty and safety rules:
 *  - Generated code is NEVER executed server-side. It runs only in the
 *    browser, inside an iframe with `sandbox="allow-scripts"` (no
 *    allow-same-origin → it cannot touch the app's origin/storage).
 *  - We inject a strict CSP meta tag that blocks resource fetches/forms, not all frame navigation.
 *    Generated apps remain untrusted; never grant them credentials.
 *  - Every version records its real engine (`via`) and whether it was the
 *    deterministic offline scaffold (fallback: true) or model output.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { foundryApps, foundryVersions } from "@/db/schema";
import { generate, type ChatMsg } from "@/lib/ai";

export type FoundryVersion = {
  id: string;
  appId: string;
  version: number;
  prompt: string;
  code: string;
  engine: string;
  via: string;
  fallback: boolean;
  createdAt: string;
};

export type FoundryApp = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  latest?: FoundryVersion;
  versionCount?: number;
};

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; ` +
  `style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'">`;

const CSP_HEAD_PREFIX = `<!doctype html><html><head>${CSP_META}`;

/** Put our policy BEFORE all untrusted content. A model-supplied CSP cannot
 * relax it, nor can an early script run before it. Resource fetches/forms are
 * blocked; this is not a general network firewall against frame navigation. */
export function injectCsp(code: string): string {
  if (code.startsWith(CSP_HEAD_PREFIX)) return code;
  return CSP_HEAD_PREFIX + "</head><body>" + code + "</body></html>";
}

export const KV_MAX_KEYS = 200;
export const KV_MAX_VALUE_BYTES = 32 * 1024;
export const KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const KV_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * The sandboxed app's "backend": a tiny KV client injected into preview
 * documents. It talks ONLY to the parent page via postMessage (never the
 * network — the CSP blocks that); the parent proxies to
 * /api/foundry/[id]/data, which is strictly app-scoped and capped.
 * Generated apps use: await window.arena.kv.set(key, value) / get / del / keys.
 */
export const ARENA_BRIDGE_SCRIPT = `<script>
(function () {
  var pending = new Map(); var seq = 0;
  window.arena = {
    version: 1,
    kv: {
      get: function (k) { return call("get", k); },
      set: function (k, v) { return call("set", k, v); },
      del: function (k) { return call("del", k); },
      keys: function () { return call("keys"); }
    }
  };
  function call(op, key, value) {
    return new Promise(function (resolve, reject) {
      var requestId = "q" + (++seq);
      var timer = setTimeout(function () { pending.delete(requestId); reject(new Error("App storage did not acknowledge the operation. Retry; no empty value was substituted.")); }, 15000);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      parent.postMessage({ __arena: "request", requestId: requestId, op: op, key: key, value: value }, "*");
    });
  }
  addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.__arena !== "response") return;
    var call = pending.get(data.requestId);
    if (call) { pending.delete(data.requestId); clearTimeout(call.timer); if (data.result && data.result.ok === false) call.reject(new Error(data.result.error || "App storage operation failed")); else call.resolve(data.result); }
  });
})();
</script>`;

/** Inject the postMessage KV bridge into a preview document (idempotent). */
export function injectArenaBridge(code: string): string {
  if (code.includes(ARENA_BRIDGE_SCRIPT)) return code;
  if(code.startsWith(CSP_HEAD_PREFIX))return CSP_HEAD_PREFIX + ARENA_BRIDGE_SCRIPT + code.slice(CSP_HEAD_PREFIX.length);
  const headOpen = code.search(/<head[^>]*>/i);
  if (headOpen !== -1) {
    const insertAt = code.indexOf(">", headOpen) + 1;
    return code.slice(0, insertAt) + "\n  " + ARENA_BRIDGE_SCRIPT + code.slice(insertAt);
  }
  const htmlOpen = code.search(/<html[^>]*>/i);
  if (htmlOpen !== -1) {
    const insertAt = code.indexOf(">", htmlOpen) + 1;
    return code.slice(0, insertAt) + "<head>" + ARENA_BRIDGE_SCRIPT + "</head>" + code.slice(insertAt);
  }
  return `<!doctype html><html><head>${ARENA_BRIDGE_SCRIPT}</head><body>${code}</body></html>`;
}

/** Pull the HTML document out of a model reply (fenced or raw). */
export function extractHtml(reply: string): string | null {
  const fences = [...reply.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const candidates = [...fences, reply.trim()];
  for (const candidate of candidates) {
    if (/<!doctype html|<html[\s>]/i.test(candidate) && candidate.includes("</html>")) {
      return candidate;
    }
  }
  return null;
}

/** The honest offline floor: a real, working starter app — never branded as model output. */
export function fallbackScaffold(description: string, name = "My app"): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)}</title>
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center}
    .card{max-width:560px;padding:40px;border-radius:20px;background:linear-gradient(135deg,#1e1b4b,#312e81);text-align:center}
    h1{margin:0 0 8px;font-size:30px}
    p{color:#c7d2fe;line-height:1.6}
    button{margin-top:18px;padding:10px 22px;border-radius:10px;border:0;background:#818cf8;color:#0b1020;font-weight:700;font-size:15px;cursor:pointer}
    small{display:block;margin-top:22px;color:#818cf8}
  </style>
</head>
<body>
  <div class="card">
    <h1>${esc(name)}</h1>
    <p>You described: &ldquo;${esc(description.trim().slice(0, 240))}&rdquo;</p>
    <button id="go">Click me</button>
    <p id="out" style="min-height:1.4em"></p>
    <small>Offline scaffold by the Arena Local Engine — clearly not model output.<br>
    Wire a bigger brain (Model Hub / BYOK keys / a hub model) and press Build again for the real thing.</small>
  </div>
  <script>
    let n = 0;
    document.getElementById("go").addEventListener("click", () => {
      n += 1;
      document.getElementById("out").textContent = "clicked " + n + " time" + (n === 1 ? "" : "s") + " at " + new Date().toLocaleTimeString();
    });
  </script>
</body>
</html>`;
}

const SYSTEM_PROMPT =
  `You are a senior frontend engineer. The user describes an app; you return ONE complete, ` +
  `self-contained HTML document (<!doctype html> … </html>) that implements it. ` +
  `Rules: inline <style> and <script> only; NO external requests (no CDNs, no fetch to other sites — ` +
  `a strict CSP blocks them anyway); works offline; dark theme, polished, responsive. ` +
  `Persistence: the page gets a window.arena.kv API (async get/set/del/keys, ~32KB values) ` +
  `backed by the app's database — use it for anything that should survive a reload. ` +
  `Reply with the document in a single \`\`\`html fence and nothing else.`;

function appPrompt(description: string): string {
  return `Build this app: ${description.trim()}`;
}

function iteratePrompt(currentCode: string, change: string): string {
  return (
    `Here is the current app code:\n\n\`\`\`html\n${currentCode}\n\`\`\`\n\n` +
    `Apply this change and return the FULL updated document (same rules, single \`\`\`html fence):\n${change.trim()}`
  );
}

async function generateVersion(
  messages: ChatMsg[],
  fallbackCode: () => string,
  opts: { keys?: Record<string, string>; modelId?: string },
): Promise<{ code: string; engine: string; via: string; fallback: boolean }> {
  const result = await generate({
    modelId: opts.modelId ?? "local-engine",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    keys: opts.keys as never,
    temperature: 0.5,
    maxTokens: 4000,
  });
  const html = extractHtml(result.text);
  if (html && html.length > 400) {
    return { code: injectArenaBridge(injectCsp(html)), engine: result.backend, via: result.via ?? result.backend, fallback: result.fallback === true };
  }
  // Honest fallback: the model's reply wasn't a usable document.
  return {
    code: injectArenaBridge(injectCsp(fallbackCode())),
    engine: result.backend,
    via: `${result.via ?? result.backend}+offline-scaffold`,
    fallback: true,
  };
}

export async function createApp(
  description: string,
  opts: { name?: string; keys?: Record<string, string>; modelId?: string } = {},
): Promise<FoundryApp & { latest: FoundryVersion }> {
  const rawName = opts.name?.trim() || description.split(/[.,\n]/)[0] || "New app";
  const name = rawName.length > 48 ? `${rawName.slice(0, 44).replace(/\s+\S*$/, "")}…` : rawName;
  const built = await generateVersion([{ role: "user", content: appPrompt(description) }], () => fallbackScaffold(description, name), opts);
  return db.transaction(async tx => {
  const [app] = await tx.insert(foundryApps).values({ name }).returning();
  const [version] = await tx
    .insert(foundryVersions)
    .values({
      appId: app.id,
      version: 1,
      prompt: description,
      code: built.code,
      engine: built.engine,
      via: built.via,
      fallback: built.fallback,
    })
    .returning();
  return {
    id: app.id,
    name: app.name,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    latest: versionView(version),
  };
  });
}

export class FoundryVersionConflict extends Error {
  constructor() {
    super("This app changed while your iteration was being prepared. Reopen the latest app and review your retained change before rebuilding.");
  }
}

export async function iterateApp(
  appId: string,
  change: string,
  opts: { keys?: Record<string, string>; modelId?: string; expectedVersionId?: string } = {},
): Promise<FoundryVersion | null> {
  const [current] = await db
    .select()
    .from(foundryVersions)
    .where(eq(foundryVersions.appId, appId))
    .orderBy(desc(foundryVersions.version))
    .limit(1);
  if (!current) return null;
  if (opts.expectedVersionId && opts.expectedVersionId !== current.id) throw new FoundryVersionConflict();
  const built = await generateVersion(
    [
      { role: "user", content: appPrompt(current.prompt) },
      { role: "assistant", content: "```html\n" + current.code + "\n```" },
      { role: "user", content: iteratePrompt(current.code, change) },
    ],
    () => current.code, // a failed iteration keeps the previous working app
    opts,
  );
  // Inference stays outside the transaction. Lock the existing app only for
  // publication, then compare its current head with the exact code we built on.
  // Numbering a stale build as a newer version would silently lose an edit.
  return db.transaction(async tx => {
    const [app] = await tx.select({ id: foundryApps.id }).from(foundryApps)
      .where(eq(foundryApps.id, appId)).for("update");
    if (!app) return null;
    const [latest] = await tx.select({ id: foundryVersions.id }).from(foundryVersions)
      .where(eq(foundryVersions.appId, appId)).orderBy(desc(foundryVersions.version)).limit(1);
    if (latest?.id !== current.id) throw new FoundryVersionConflict();
    const [version] = await tx
      .insert(foundryVersions)
      .values({
        appId,
        version: current.version + 1,
        prompt: change,
        code: built.code,
        engine: built.engine,
        via: built.via,
        fallback: built.fallback,
      })
      .returning();
    await tx.update(foundryApps).set({ updatedAt: new Date() }).where(eq(foundryApps.id, appId));
    return versionView(version);
  });
}

export async function listApps(): Promise<FoundryApp[]> {
  const apps = await db.select().from(foundryApps).orderBy(desc(foundryApps.updatedAt));
  const result: FoundryApp[] = [];
  for (const app of apps) {
    const [latest] = await db
      .select()
      .from(foundryVersions)
      .where(eq(foundryVersions.appId, app.id))
      .orderBy(desc(foundryVersions.version))
      .limit(1);
    result.push({
      id: app.id,
      name: app.name,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
      versionCount: latest?.version ?? 0,
    });
  }
  return result;
}

export async function getApp(appId: string): Promise<(FoundryApp & { latest: FoundryVersion }) | null> {
  const [app] = await db.select().from(foundryApps).where(eq(foundryApps.id, appId)).limit(1);
  if (!app) return null;
  const [latest] = await db
    .select()
    .from(foundryVersions)
    .where(eq(foundryVersions.appId, appId))
    .orderBy(desc(foundryVersions.version))
    .limit(1);
  if (!latest) return null;
  return {
    id: app.id,
    name: app.name,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    latest: versionView(latest),
  };
}

export async function deleteApp(appId: string): Promise<boolean> {
  const removed = await db.delete(foundryApps).where(eq(foundryApps.id, appId)).returning({ id: foundryApps.id });
  return removed.length > 0;
}

function versionView(row: typeof foundryVersions.$inferSelect): FoundryVersion {
  return {
    id: row.id,
    appId: row.appId,
    version: row.version,
    prompt: row.prompt,
    code: row.code,
    engine: row.engine,
    via: row.via,
    fallback: row.fallback,
    createdAt: row.createdAt.toISOString(),
  };
}
