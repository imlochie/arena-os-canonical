/**
 * Space external actions (docs/spaces-autonomy.md Phase D) — real phone
 * calls, real SMS, real payment links. The strictest tier of the check-in
 * environment.
 *
 * EVERY tool in this module is approval-gated (action classes external.call,
 * external.sms, payment.link in governance.ts): a mission can compose the
 * request, but nothing leaves this machine until a human approves that exact
 * instance — recipient, message, amount are all in the approval payload.
 *
 * Provider model — owner-configured, never bundled:
 *   - Telephony (calls + SMS): Twilio. Requires TWILIO_ACCOUNT_SID,
 *     TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID
 *     for SMS) in the server environment. No account is bundled and none is
 *     assumed: unconfigured → an honest, actionable message, never a fake call.
 *   - Payments: Stripe. Requires STRIPE_API_KEY. A payment link is created
 *     through the real REST API (product → price → payment link) and the tool
 *     returns the shareable URL. Hard safety cap: links over
 *     MAX_PAYMENT_AMOUNT_USD (default 250) are refused outright.
 *
 * Everything is injectable (fetcher) so the exact REST payloads, validation,
 * caps, and unconfigured paths are unit-tested without any provider account.
 */

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>;

const realFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.text() };
};

export interface ExternalDeps {
  fetcher?: Fetcher;
  env?: Record<string, string | undefined>;
}

// ---------------- validation ----------------

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}

export function sanitizeMessage(message: string): string {
  // SMS segment safety + no control characters.
  return message.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 1_600);
}

export function maxPaymentAmountUsd(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.MAX_PAYMENT_AMOUNT_USD ?? "250");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 250;
}

// ---------------- telephony (Twilio) ----------------

export function twilioConfig(env: Record<string, string | undefined> = process.env) {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return { sid, token, from: env.TWILIO_FROM_NUMBER?.trim() ?? "", messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? "" };
}

function twilioUrl(sid: string, path: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}.json`;
}

function twilioHeaders(sid: string, token: string): { headers: Record<string, string> } {
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");
  return { headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" } };
}

function form(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** A spoken call: Twilio TwiML <Say>. Returns the call SID on success. */
export async function toolExternalCall(
  input: { to: string; message: string },
  deps: ExternalDeps = {},
): Promise<string> {
  const env = deps.env ?? process.env;
  const to = String(input.to ?? "").trim();
  const message = sanitizeMessage(String(input.message ?? ""));
  if (!isValidE164(to)) return `error: external_call needs the recipient in E.164 format (e.g. +61412345678) — got "${to}"`;
  if (!message) return "error: external_call needs a message to speak";
  const cfg = twilioConfig(env);
  if (!cfg || !cfg.from) {
    return "error: phone calls are not configured — the owner must set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER (a real Twilio account with voice capability; no call can be placed without it)";
  }
  const twiml = `<Response><Say voice="Polly.Joanna">${message.replace(/[<>&]/g, " ")}</Say></Response>`;
  const fetcher = deps.fetcher ?? realFetcher;
  try {
    const res = await fetcher(twilioUrl(cfg.sid, "Calls"), {
      method: "POST",
      ...twilioHeaders(cfg.sid, cfg.token),
      body: form({ To: to, From: cfg.from, Twiml: twiml }),
    });
    const parsed = JSON.parse(res.body) as { sid?: string; message?: string };
    if (res.status >= 200 && res.status < 300 && parsed.sid) {
      return `call placed to ${to} (Twilio SID ${parsed.sid}) — the recipient will hear the approved message spoken`;
    }
    return `error: Twilio refused the call (${res.status}): ${parsed.message ?? res.body.slice(0, 300)}`;
  } catch (e) {
    return `error: the call request failed: ${e instanceof Error ? e.message : "network error"}`;
  }
}

/** An SMS via Twilio (from number or messaging service). */
export async function toolExternalSms(
  input: { to: string; message: string },
  deps: ExternalDeps = {},
): Promise<string> {
  const env = deps.env ?? process.env;
  const to = String(input.to ?? "").trim();
  const message = sanitizeMessage(String(input.message ?? ""));
  if (!isValidE164(to)) return `error: external_sms needs the recipient in E.164 format (e.g. +61412345678) — got "${to}"`;
  if (!message) return "error: external_sms needs a message body";
  const cfg = twilioConfig(env);
  if (!cfg || (!cfg.from && !cfg.messagingServiceSid)) {
    return "error: SMS is not configured — the owner must set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID (a real Twilio account; no message can be sent without it)";
  }
  const payload: Record<string, string> = { To: to, Body: message };
  if (cfg.messagingServiceSid) payload.MessagingServiceSid = cfg.messagingServiceSid;
  else payload.From = cfg.from;
  const fetcher = deps.fetcher ?? realFetcher;
  try {
    const res = await fetcher(twilioUrl(cfg.sid, "Messages"), {
      method: "POST",
      ...twilioHeaders(cfg.sid, cfg.token),
      body: form(payload),
    });
    const parsed = JSON.parse(res.body) as { sid?: string; message?: string };
    if (res.status >= 200 && res.status < 300 && parsed.sid) {
      return `SMS sent to ${to} (Twilio SID ${parsed.sid})`;
    }
    return `error: Twilio refused the message (${res.status}): ${parsed.message ?? res.body.slice(0, 300)}`;
  } catch (e) {
    return `error: the SMS request failed: ${e instanceof Error ? e.message : "network error"}`;
  }
}

// ---------------- payments (Stripe payment links) ----------------

export interface PaymentLinkResult {
  ok: boolean;
  output: string;
}

/** Create a REAL Stripe payment link (product → price → link). The URL is
 * the deliverable: share it and the payer pays the owner's own Stripe
 * account. Amount is capped hard. */
export async function toolPaymentLink(
  input: { amount: string | number; description: string; currency?: string },
  deps: ExternalDeps = {},
): Promise<PaymentLinkResult> {
  const env = deps.env ?? process.env;
  const amount = Number(input.amount);
  const description = String(input.description ?? "").trim().slice(0, 200);
  const currency = (String(input.currency ?? "usd").toLowerCase().match(/^[a-z]{3}$/) ?? ["usd"])[0];
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, output: `error: payment_link needs a positive amount — got "${input.amount}"` };
  }
  if (!description) return { ok: false, output: "error: payment_link needs a description (what the payer is paying for)" };
  const cents = Math.round(amount * 100);
  const capCents = maxPaymentAmountUsd(env) * 100;
  if (cents > capCents) {
    return { ok: false, output: `error: payment_link refused — $${(cents / 100).toFixed(2)} exceeds the safety cap of $${(capCents / 100).toFixed(2)} (MAX_PAYMENT_AMOUNT_USD). Ask the owner to raise the cap or split the charge.` };
  }
  const key = env.STRIPE_API_KEY?.trim();
  if (!key) {
    return { ok: false, output: "error: payments are not configured — the owner must set STRIPE_API_KEY (a real Stripe account in the owner's name; no link can be created without it)" };
  }
  const fetcher = deps.fetcher ?? realFetcher;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" };
  try {
    // 1) product
    const product = await fetcher("https://api.stripe.com/v1/products", {
      method: "POST", headers, body: form({ name: description }),
    });
    const productJson = JSON.parse(product.body) as { id?: string; error?: { message?: string } };
    if (!productJson.id) {
      return { ok: false, output: `error: Stripe refused the product (${product.status}): ${productJson.error?.message ?? product.body.slice(0, 300)}` };
    }
    // 2) price
    const price = await fetcher("https://api.stripe.com/v1/prices", {
      method: "POST", headers,
      body: form({ product: productJson.id, unit_amount: String(cents), currency }),
    });
    const priceJson = JSON.parse(price.body) as { id?: string; error?: { message?: string } };
    if (!priceJson.id) {
      return { ok: false, output: `error: Stripe refused the price (${price.status}): ${priceJson.error?.message ?? price.body.slice(0, 300)}` };
    }
    // 3) payment link
    const link = await fetcher("https://api.stripe.com/v1/payment_links", {
      method: "POST", headers,
      body: form({ "line_items[0][price]": priceJson.id, "line_items[0][quantity]": "1" }),
    });
    const linkJson = JSON.parse(link.body) as { url?: string; error?: { message?: string } };
    if (!linkJson.url) {
      return { ok: false, output: `error: Stripe refused the payment link (${link.status}): ${linkJson.error?.message ?? link.body.slice(0, 300)}` };
    }
    return { ok: true, output: `payment link created: ${linkJson.url} ($${(cents / 100).toFixed(2)} ${currency.toUpperCase()} — pays into the owner's Stripe account)` };
  } catch (e) {
    return { ok: false, output: `error: the payment link request failed: ${e instanceof Error ? e.message : "network error"}` };
  }
}
