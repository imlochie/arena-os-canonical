import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";

// Mind (mymind dupe) + Subscriptions (Bobby dupe) test suite.

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

// ----------------------------------------------------------------- mind lib

test("mind: capture classification (link / quote / note)", async () => {
  const { classifyCapture } = await import("@/lib/mind");
  const link = classifyCapture("https://example.com/article");
  assert.equal(link.kind, "link");
  assert.equal(link.url, "https://example.com/article");
  const quote = classifyCapture("\u201cLocal-first is a feature, not a compromise.\u201d");
  assert.equal(quote.kind, "quote");
  assert.equal(quote.text, "Local-first is a feature, not a compromise.");
  const note = classifyCapture("remember to fix the mixdown levels tomorrow");
  assert.equal(note.kind, "note");
});

test("mind: local keyword tags are the honest offline floor", async () => {
  const { localKeywordTags } = await import("@/lib/mind");
  const tags = localKeywordTags("The stems pipeline separates drums from drums-heavy mixes with drums precision", "note");
  assert.equal(tags[0], "note");
  assert.ok(tags.includes("drums"));
  assert.ok(tags.length <= 6);
  // stopwords are dropped
  const quiet = localKeywordTags("the a and or but with from this that", "note");
  assert.deepEqual(quiet, ["note"]);
});

test("mind: capture → auto-process → list → favorite → serendipity → smart space → delete", { skip: !pgUp }, async () => {
  const { createMindItem, listMindItems, toggleFavorite, updateItemTags, deleteMindItem, serendipityPick, smartSpaceMatches } = await import("@/lib/mind");
  const { pool } = await import("@/db");
  const { archiveItems } = await import("@/db/schema");

  const note = await createMindItem({ text: "The Waveyard stems pipeline now supports 4-stem separation with ffmpeg preprocessing" });
  const link = await createMindItem({ text: "https://example.com/mixing-guide" });
  const quote = await createMindItem({ text: "\u201cEverything local, nothing leaked.\u201d" });

  assert.equal(note.kind, "note");
  assert.equal(link.kind, "link");
  assert.equal(link.name, "example.com");
  assert.equal(quote.kind, "quote");
  // Auto-processing always labels the engine honestly.
  for (const item of [note, link, quote]) {
    assert.ok(item.tags.length >= 1);
    assert.ok(item.engine.length > 0);
    assert.ok(item.engine === "local-keywords" || item.engine !== "");
  }

  const listed = await listMindItems({ q: "stems" });
  assert.ok(listed.some((i) => i.id === note.id), "full-text search must find the note");

  const fav = await toggleFavorite(note.id);
  assert.equal(fav, true);
  const favs = await listMindItems({ favoritesOnly: true });
  assert.ok(favs.every((i) => i.favorite));

  const retagged = await updateItemTags(note.id, ["custom-tag", "Waveyard"]);
  assert.deepEqual(retagged?.tags.sort(), ["custom-tag", "waveyard"]);

  // Smart space: a space watching the "quote" kind fills itself.
  const space = { name: "Quotes", tags: [], kinds: ["quote"] };
  const all = await listMindItems();
  const inSpace = all.filter((i) => smartSpaceMatches(i, space));
  assert.ok(inSpace.some((i) => i.id === quote.id));
  assert.ok(!inSpace.some((i) => i.id === note.id));

  // Serendipity always returns one of the items (or null when empty).
  const pick = serendipityPick(all);
  assert.ok(pick === null || all.some((i) => i.id === pick.id));
  assert.equal(serendipityPick([]), null);

  for (const item of [note, link, quote]) assert.equal(await deleteMindItem(item.id), true);
  void archiveItems;
});

// --------------------------------------------------------- subscriptions lib

test("subscriptions: cadence math — monthly equivalents, rollover, days-until", async () => {
  const { monthlyEquivalentCents, rollForward, daysUntil, parseAmountCents, normalizeDate } = await import("@/lib/subscriptions");
  assert.equal(monthlyEquivalentCents(1200, "yearly"), 100);
  assert.equal(monthlyEquivalentCents(100, "weekly") > 400, true); // ~433
  assert.equal(monthlyEquivalentCents(999, "monthly"), 999);
  assert.equal(monthlyEquivalentCents(900, "quarterly"), 300);

  const now = new Date("2026-10-11T00:00:00Z");
  assert.equal(rollForward("2026-01-10", "monthly", now), "2026-11-10");
  assert.equal(rollForward("2026-10-15", "monthly", now), "2026-10-15");
  assert.equal(rollForward("2025-10-11", "yearly", now), "2026-10-11");
  assert.equal(daysUntil("2026-10-14", now), 3);
  assert.equal(daysUntil("2026-10-11", now), 0);

  assert.equal(parseAmountCents("12.99"), 1299);
  assert.equal(parseAmountCents("$1,299.00"), 129900);
  assert.equal(parseAmountCents("not a price"), null);
  assert.equal(normalizeDate("2026-10-12"), "2026-10-12");
  assert.equal(normalizeDate("12 Oct 2026"), "2026-10-12");
  assert.equal(normalizeDate("nonsense"), null);
});

test("subscriptions: stats, CRUD, and receipt extraction (regex floor + honest none)", { skip: !pgUp }, async () => {
  const { createSubscription, listSubscriptions, updateSubscription, deleteSubscription, computeStats, extractSubscriptionFromEmail, regexExtract } = await import("@/lib/subscriptions");
  const { pool } = await import("@/db");

  const now = new Date("2026-10-11T00:00:00Z");
  const netflix = await createSubscription({ name: "Netflix", amountCents: 1799, currency: "USD", cadence: "monthly", nextCharge: "2026-10-14" });
  const domain = await createSubscription({ name: "Domain", amountCents: 1500, currency: "USD", cadence: "yearly", nextCharge: "2027-03-01" });

  let rows = await listSubscriptions();
  assert.ok(rows.some((r) => r.id === netflix.id));
  const stats = computeStats(rows, now);
  assert.equal(stats.activeCount, rows.filter((r) => r.active).length);
  // 17.99 + 15.00/12 = 19.24
  assert.equal(stats.monthlyCents, 1799 + 125);
  assert.ok(stats.upcoming.some((u) => u.id === netflix.id && u.daysAway === 3));
  assert.ok(!stats.upcoming.some((u) => u.id === domain.id));

  const paused = await updateSubscription(netflix.id, { active: false });
  assert.equal(paused?.active, false);
  rows = await listSubscriptions();
  assert.equal(computeStats(rows, now).activeCount, rows.length - 1);

  // Regex floor: a realistic receipt email.
  const receipt =
    "Thanks for your subscription!\n\nYour Netflix subscription renews on Oct 14, 2026. " +
    "Amount: $17.99 USD (billed monthly).\nQuestions? Reply to this email.";
  const regex = regexExtract(receipt);
  assert.ok(regex);
  assert.equal(regex!.confidence, "regex");
  assert.equal(regex!.amountCents, 1799);
  assert.equal(regex!.cadence, "monthly");
  assert.equal(regex!.nextCharge, "2026-10-14");

  // Full extraction: local engine likely fails JSON → regex floor answers.
  const extracted = await extractSubscriptionFromEmail(receipt);
  if (extracted.confidence === "none") {
    assert.fail("regex floor should have parsed this receipt");
  } else {
    assert.equal(extracted.amountCents, 1799);
    assert.equal(extracted.cadence, "monthly");
  }
  // Honest none on gibberish.
  const none = await extractSubscriptionFromEmail("hello there nothing to see");
  assert.equal(none.confidence, "none");

  assert.equal(await deleteSubscription(netflix.id), true);
  assert.equal(await deleteSubscription(domain.id), true);
});

// One shared pool lifecycle for the whole file.
after(async () => {
  if (pgUp) {
    const { pool } = await import("@/db");
    await pool.end().catch(() => {});
  }
});
