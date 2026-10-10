import {
  EmailInboxError,
  deleteEmailAccount,
  importReceiptCandidate,
  listEmailAccounts,
  saveEmailAccount,
  scanInboxForReceipts,
  testImapConnection,
  type InboxErrorCode,
} from "@/lib/emailInbox";
import type { Cadence } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CODE_STATUS: Record<InboxErrorCode, number> = {
  auth_failed: 401,
  connect_failed: 502,
  dns_failed: 502,
  timeout: 504,
  scan_failed: 500,
  not_found: 404,
  bad_input: 400,
};

function inboxError(error: unknown): Response {
  if (error instanceof EmailInboxError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: CODE_STATUS[error.code] ?? 500 },
    );
  }
  console.error(error);
  return Response.json({ error: "email_route_failed", message: "Unexpected error." }, { status: 500 });
}

// GET → saved accounts (credentials never included)
export async function GET() {
  try {
    const accounts = await listEmailAccounts();
    return Response.json({ accounts });
  } catch (e) {
    return inboxError(e);
  }
}

// POST {action}:
//   test    {host, port?, tls?, username, password} or {accountId}
//   save    {address, displayName?, host, port?, tls?, username, password}
//   delete  {id}
//   scan    {id, days?, keys?}
//   import  {name, amountCents, currency, cadence, nextCharge, category?, notes?}
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_input", message: "JSON body required." }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const keys = (body.keys && typeof body.keys === "object" ? body.keys : undefined) as
    | Record<string, string>
    | undefined;

  try {
    if (action === "test") {
      // Credentials for a test are supplied inline (they are never persisted
      // by this action); saved passwords are sealed and not re-exposed.
      const creds = {
        host: String(body.host ?? ""),
        port: Number(body.port ?? 993) || 993,
        tls: body.tls !== false,
        username: String(body.username ?? ""),
        password: String(body.password ?? ""),
      };
      if (!creds.host || !creds.username || !creds.password) {
        return Response.json({ error: "bad_input", message: "host, username and password are required." }, { status: 400 });
      }
      const result = await testImapConnection(creds);
      return Response.json(result);
    }

    if (action === "save") {
      const account = await saveEmailAccount({
        address: String(body.address ?? ""),
        displayName: body.displayName === undefined ? undefined : String(body.displayName),
        host: String(body.host ?? ""),
        port: Number(body.port ?? 993) || 993,
        tls: body.tls !== false,
        username: String(body.username ?? ""),
        password: String(body.password ?? ""),
      });
      return Response.json({ account }, { status: 201 });
    }

    if (action === "delete") {
      const removed = await deleteEmailAccount(String(body.id ?? ""));
      if (!removed) return Response.json({ error: "not_found", message: "Account not found." }, { status: 404 });
      return Response.json({ removed: true });
    }

    if (action === "scan") {
      const result = await scanInboxForReceipts(String(body.id ?? ""), {
        days: Number(body.days ?? 60) || 60,
        keys,
      });
      return Response.json(result);
    }

    if (action === "import") {
      const cadenceRaw = String(body.cadence ?? "monthly") as Cadence;
      const created = await importReceiptCandidate({
        name: String(body.name ?? ""),
        amountCents: Number(body.amountCents ?? 0),
        currency: String(body.currency ?? "USD"),
        cadence: cadenceRaw,
        nextCharge: String(body.nextCharge ?? ""),
        category: body.category === undefined ? undefined : String(body.category),
        notes: body.notes === undefined ? undefined : String(body.notes),
      });
      return Response.json({ subscription: created }, { status: 201 });
    }

    return Response.json({ error: "bad_input", message: "Unknown action." }, { status: 400 });
  } catch (e) {
    return inboxError(e);
  }
}
