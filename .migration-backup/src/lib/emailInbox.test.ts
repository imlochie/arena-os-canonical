import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// Email inbox (owner-side IMAP) test suite.
//
// The IMAP transport is proven against a REAL protocol server: the suite runs
// a minimal RFC-3501 server on 127.0.0.1 (greeting, LOGIN, LIST, EXAMINE,
// UID SEARCH, UID FETCH with literal bodies, LOGOUT) and points a real
// ImapFlow client at it, so connect/auth/scan/parse is exercised end to end
// with no mocks of our code. Failure paths (refused connection, unknown
// account) are asserted against real behavior too.

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL ?? "";
  if (envUrl && !envUrl.includes("arena-test-no-connect")) return envUrl;
  try {
    const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = env.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  return "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
}

async function localPostgresUp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 5432), timeout: 800 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

const databaseUrl = resolveDatabaseUrl();
const pgUp = await localPostgresUp(databaseUrl);
process.env.DATABASE_URL = databaseUrl;

/* ----------------------------- secretBox --------------------------------- */

test("secretBox seals, opens, and rejects tampering", async () => {
  const { sealSecret, openSecret, isSealedSecret } = await import("./secretBox");
  const sealed = sealSecret("app-password-123");
  assert.match(sealed, /^v1\./);
  assert.ok(isSealedSecret(sealed));
  assert.equal(openSecret(sealed), "app-password-123");
  const parts = sealed.split(".");
  const tamperedCt = Buffer.from(parts[3], "base64");
  tamperedCt[0] ^= 0xff;
  parts[3] = tamperedCt.toString("base64");
  assert.throws(() => openSecret(parts.join(".")));
  assert.throws(() => openSecret("v2.aaaa.bbbb.cccc"));
});

/* ----------------------------- htmlToText -------------------------------- */

test("htmlToText keeps the facts a receipt needs", async () => {
  const { htmlToText } = await import("./emailInbox");
  const text = htmlToText(
    `<html><body><p>Your <b>Netflix Standard</b> subscription renews <b>Nov 1, 2026</b></p>` +
      `<p>Amount: <span>$15.49</span> per month</p></body></html>`,
  );
  assert.match(text, /Netflix Standard/);
  assert.match(text, /\$15\.49/);
  assert.match(text, /Nov 1, 2026/);
  assert.equal(htmlToText("<script>steal()</script><style>a{}</style><p>clean</p>"), "clean");
});

/* ------------------- MIME parsing → extraction pipeline ------------------ */

test("mailparser + extraction pipeline on a real multipart receipt", async () => {
  const { simpleParser } = await import("mailparser");
  const { regexExtract } = await import("./subscriptions");
  const raw = [
    "From: Netflix <info@netflix.com>",
    "To: user@example.com",
    "Subject: Your Netflix billing update",
    "Date: Sun, 11 Oct 2026 09:30:00 +0000",
    "Message-ID: <receipt-2@test.local>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BOUND2"',
    "",
    "--BOUND2",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your Netflix Standard subscription will renew Nov 1, 2026 for $15.49 per month.",
    "--BOUND2",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Your <b>Netflix Standard</b> subscription will renew Nov 1, 2026 for <b>$15.49 per month</b>.</p></body></html>",
    "--BOUND2--",
    "",
  ].join("\r\n");
  const parsed = await simpleParser(Buffer.from(raw, "utf8"));
  assert.equal(parsed.subject, "Your Netflix billing update");
  assert.match(parsed.text ?? "", /Netflix Standard/);
  const extracted = regexExtract(parsed.text ?? "");
  if (!extracted) assert.fail("pipeline should extract the Netflix receipt");
  assert.equal(extracted.amountCents, 1549);
  assert.equal(extracted.cadence, "monthly");
  assert.equal(extracted.nextCharge, "2026-11-01");
});

/* ------------------- honest connection failure paths --------------------- */

test("testImapConnection reports a refused port honestly", async () => {
  const { testImapConnection } = await import("./emailInbox");
  // Grab a definitely-closed port: bind, read it, release.
  const port = await new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
  const result = await testImapConnection({
    host: "127.0.0.1",
    port,
    tls: false,
    username: "user@example.com",
    password: "wrong",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "connect_failed");
});

/* ------------------------- minimal real IMAP server ---------------------- */

const CRLF = "\r\n";

class MiniImapServer {
  private messages: { raw: string; envelope: string }[] = [];
  private server: net.Server | null = null;
  port = 0;

  addMessage(raw: string, envelope: string): void {
    this.messages.push({ raw, envelope });
  }

  async start(): Promise<void> {
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    (srv as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private handle(socket: net.Socket): void {
    socket.on("error", () => void 0);
    socket.write(`* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] mini test server ready${CRLF}`);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let index: number;
      while ((index = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.subarray(0, index).toString("utf8");
        buffer = buffer.subarray(index + 2);
        try {
          this.command(socket, line);
        } catch {
          /* a broken command never kills the server */
        }
      }
    });
  }

  private command(socket: net.Socket, line: string): void {
    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) return;
    const [, tag, rest] = match;
    const ok = `${tag} OK completed${CRLF}`;
    const verb = rest.split(/\s+/)[0]?.toUpperCase();

    if (verb === "CAPABILITY") {
      socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN${CRLF}${tag} OK CAPABILITY completed${CRLF}`);
    } else if (verb === "LOGIN") {
      socket.write(`${tag} OK LOGIN completed${CRLF}`);
    } else if (verb === "LIST") {
      socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}${tag} OK LIST completed${CRLF}`);
    } else if (verb === "SELECT" || verb === "EXAMINE") {
      const n = this.messages.length;
      socket.write(`* ${n} EXISTS${CRLF}* 0 RECENT${CRLF}`);
      socket.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}`);
      socket.write(`* OK [UIDVALIDITY 1] UIDs valid${CRLF}`);
      socket.write(`* OK [UIDNEXT ${n + 1}] Predicted next UID${CRLF}`);
      socket.write(`${tag} OK [READ-ONLY] ${verb} completed${CRLF}`);
    } else if (verb === "UID") {
      const inner = rest.replace(/^\S+\s+/, "");
      const innerVerb = inner.split(/\s+/)[0]?.toUpperCase();
      if (innerVerb === "SEARCH") {
        const uids = this.messages.map((_, i) => i + 1);
        socket.write(`* SEARCH${uids.length ? ` ${uids.join(" ")}` : ""}${CRLF}${tag} OK SEARCH completed${CRLF}`);
      } else if (innerVerb === "FETCH") {
        this.fetchAll(socket, tag);
      } else {
        socket.write(ok);
      }
    } else if (verb === "FETCH") {
      this.fetchAll(socket, tag);
    } else if (verb === "LOGOUT") {
      socket.write(`* BYE mini server signing off${CRLF}${tag} OK LOGOUT completed${CRLF}`);
      socket.end();
    } else {
      socket.write(ok);
    }
  }

  private fetchAll(socket: net.Socket, tag: string): void {
    for (let i = 0; i < this.messages.length; i += 1) {
      const raw = Buffer.from(this.messages[i].raw, "utf8");
      socket.write(`* ${i + 1} FETCH (UID ${i + 1} ENVELOPE ${this.messages[i].envelope} BODY[] {${raw.length}}${CRLF}`);
      socket.write(raw);
      socket.write(`)${CRLF}`);
    }
    socket.write(`${tag} OK FETCH completed${CRLF}`);
  }
}

const env = (date: string, subject: string, fromName: string, fromMailbox: string, fromHost: string, messageId: string) =>
  `(${JSON.stringify(date)} ${JSON.stringify(subject)} ` +
  `((${JSON.stringify(fromName)} NIL ${JSON.stringify(fromMailbox)} ${JSON.stringify(fromHost)})) ` +
  `((${JSON.stringify(fromName)} NIL ${JSON.stringify(fromMailbox)} ${JSON.stringify(fromHost)})) ` +
  `(("user" NIL "user" "example.com")) NIL NIL NIL NIL NIL ${JSON.stringify(messageId)})`;

const SPOTIFY_RAW = [
  "From: Spotify Billing <billing@spotify.com>",
  "To: user@example.com",
  "Subject: Your Spotify Premium receipt",
  "Date: Mon, 12 Oct 2026 10:00:00 +0000",
  "Message-ID: <receipt-1@test.local>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Thanks for your subscription! Your Spotify Premium subscription renews on Oct 22, 2026.",
  "Amount: $11.99 USD (billed monthly).",
  "",
].join(CRLF);

const NETFLIX_RAW = [
  "From: Netflix <info@netflix.com>",
  "To: user@example.com",
  "Subject: Your Netflix billing update",
  "Date: Sun, 11 Oct 2026 09:30:00 +0000",
  "Message-ID: <receipt-2@test.local>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="BOUND2"',
  "",
  "--BOUND2",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your Netflix Standard subscription will renew Nov 1, 2026 for $15.49 per month.",
  "--BOUND2",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Your <b>Netflix Standard</b> subscription will renew Nov 1, 2026 for <b>$15.49 per month</b>.</p></body></html>",
  "--BOUND2--",
  "",
].join(CRLF);

const NEWSLETTER_RAW = [
  "From: Weekly Digest <news@example.com>",
  "To: user@example.com",
  "Subject: Cooking and travel, this week",
  "Date: Sat, 10 Oct 2026 08:00:00 +0000",
  "Message-ID: <news-1@test.local>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello! Ten links about cast iron pans and budget flights. Enjoy!",
  "",
].join(CRLF);

/* ------------------------------- PG-gated -------------------------------- */

test("email accounts: seal on save, upsert by address, never expose the password", async () => {
  if (!pgUp) return assert.fail("PG required for email account tests");
  const { saveEmailAccount, listEmailAccounts, deleteEmailAccount } = await import("./emailInbox");
  const first = await saveEmailAccount({
    address: "User@Example.com",
    host: "127.0.0.1",
    port: 1143,
    tls: false,
    username: "user@example.com",
    password: "app-password-123",
  });
  assert.equal(first.address, "user@example.com"); // normalized
  await saveEmailAccount({
    address: "user@example.com",
    host: "127.0.0.1",
    port: 2143,
    tls: false,
    username: "user@example.com",
    password: "rotated-password",
  });
  const accounts = await listEmailAccounts();
  const mine = accounts.filter((a) => a.address === "user@example.com");
  assert.equal(mine.length, 1); // upsert, not duplicate
  assert.equal(mine[0].port, 2143);
  const public_ = JSON.stringify(mine[0]);
  assert.ok(!public_.includes("rotated-password"));
  assert.ok(!public_.includes("passwordSealed"));
  assert.equal(await deleteEmailAccount(mine[0].id), true);
  assert.equal(await deleteEmailAccount(mine[0].id), false);
});

test("scanInboxForReceipts walks a real IMAP mailbox and extracts receipts", async () => {
  if (!pgUp) return assert.fail("PG required for scan test");
  const { saveEmailAccount, scanInboxForReceipts, deleteEmailAccount } = await import("./emailInbox");
  const server = new MiniImapServer();
  server.addMessage(
    NEWSLETTER_RAW,
    env("Sat, 10 Oct 2026 08:00:00 +0000", "Cooking and travel, this week", "Weekly Digest", "news", "example.com", "<news-1@test.local>"),
  );
  server.addMessage(
    NETFLIX_RAW,
    env("Sun, 11 Oct 2026 09:30:00 +0000", "Your Netflix billing update", "Netflix", "info", "netflix.com", "<receipt-2@test.local>"),
  );
  server.addMessage(
    SPOTIFY_RAW,
    env("Mon, 12 Oct 2026 10:00:00 +0000", "Your Spotify Premium receipt", "Spotify Billing", "billing", "spotify.com", "<receipt-1@test.local>"),
  );
  await server.start();
  const createdSubscriptionIds: string[] = [];
  try {
    const account = await saveEmailAccount({
      address: "scan@example.com",
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      username: "user@example.com",
      password: "app-password-123",
    });
    const result = await scanInboxForReceipts(account.id, { days: 90 });
    assert.equal(result.scanned, 3); // newsletter parsed too — it just yields no candidate
    assert.equal(result.candidates.length, 2); // Netflix + Spotify, not the newsletter
    const names = result.candidates.map((c) => c.extracted.name).sort();
    assert.deepEqual(names, ["Netflix Standard", "Spotify Premium"]);
    const spotify = result.candidates.find((c) => c.extracted.name === "Spotify Premium");
    assert.ok(spotify);
    assert.equal(spotify.extracted.amountCents, 1199);
    assert.equal(spotify.extracted.cadence, "monthly");
    assert.equal(spotify.extracted.nextCharge, "2026-10-22");
    assert.equal(spotify.subject, "Your Spotify Premium receipt");
    assert.match(spotify.from, /spotify\.com/);
    assert.equal(spotify.alreadyTracked, false);
    assert.equal(result.account.lastScanMessageCount, 3);
    assert.equal(result.account.lastError, null);

    // Import one candidate, then a rescan must flag it as already tracked.
    const { importReceiptCandidate } = await import("./emailInbox");
    const created = await importReceiptCandidate({
      name: spotify.extracted.name,
      amountCents: spotify.extracted.amountCents,
      currency: spotify.extracted.currency,
      cadence: spotify.extracted.cadence,
      nextCharge: spotify.extracted.nextCharge,
    });
    createdSubscriptionIds.push(created.id);
    const second = await scanInboxForReceipts(account.id, { days: 90 });
    const spotifyAgain = second.candidates.find((c) => c.extracted.name === "Spotify Premium");
    assert.ok(spotifyAgain);
    assert.equal(spotifyAgain.alreadyTracked, true);

    await deleteEmailAccount(account.id);
  } finally {
    await server.stop();
    if (createdSubscriptionIds.length) {
      const { deleteSubscription } = await import("./subscriptions");
      for (const id of createdSubscriptionIds) await deleteSubscription(id);
    }
  }
});

test("scanInboxForReceipts fails honestly for an unknown account", async () => {
  if (!pgUp) return assert.fail("PG required");
  const { scanInboxForReceipts, EmailInboxError } = await import("./emailInbox");
  await assert.rejects(
    scanInboxForReceipts("00000000-0000-0000-0000-000000000000"),
    (error: unknown) => error instanceof EmailInboxError && error.code === "not_found",
  );
});

// One shared pool lifecycle for the whole file.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
