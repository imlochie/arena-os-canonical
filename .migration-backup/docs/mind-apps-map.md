# The Mind-Apps Map — mymind / albo / Bobby / Mailopoly dupes

Mandate: duplicate these apps' paid features, free, inside Arena OS — same
deep-dive treatment as the 13-tools and vibe-coding maps. Features are
re-implemented from scratch (no proprietary code or assets); personal-use
stance applies.

## What shipped

- **The Mind** (`/mind`, Rooms "Remember") — the mymind dupe.
- **Subscriptions** (`/subscriptions`, Rooms "Track") — the Bobby dupe with
  the Mailopoly extraction hook.
- Migration `0012_mind_and_subscriptions.sql` (archive_items += content /
  color / favorite / engine; new subscriptions table).

## mymind → The Mind

| mymind feature (paid: $5–13/mo) | Arena implementation |
|---|---|
| Save anything: links, notes, quotes, images, PDFs | Paste bar classifies automatically (bare URL → link, quoted → quote, else note); images drop anywhere (dominant color extracted in-browser via canvas); text files read client-side. PDFs: paste text or Wave-4 file path. |
| AI auto-tagging (the core paid feature) | `autoProcess()` via the normal generate() contract — any model (Model Hub local-server, BYOK keys, keyless remote). Local Engine floor = deterministic keyword tags, labeled `local-keywords` on every card. Engine recorded per item. |
| No folders — search instead | Full-text search across name + description + tags + content (`ILIKE`, instant, offline). |
| Smart Spaces (auto-collections) | "+ space from this search" — saved filters (kinds + tags + query) that fill themselves from auto-tags (client-side, localStorage). |
| Visual card wall / moodboard | Masonry card wall, color-tinted cards from extracted dominant colors, kind emoji, tag chips. |
| Favorites | ★ toggle persisted per item. |
| Serendipity mode | 🎲 resurfaces one older, less-seen item (age-weighted, favorites down-weighted) with a highlight scroll. |
| Reading mode, article backup, OCR in images | **Not yet** — honest gaps: OCR needs tesseract (owner-side, offline — Wave 5); article backup needs a fetcher (network-blocked in sandbox, owner-side fine). |
| Browser extension / mobile apps | N/A for a local web app — the page IS the surface; PWA/extension = Wave 5 if wanted. |

Integration bonus mymind doesn't have: captures live in `archive_items`, so
chat Research mode and the Archive Assistant search them too.

## albo → covered by the Mind + honest gaps

albo (save-for-later: links, videos, books, recipes, workouts, **places**,
smart tag-watch collections, sharing, grocery lists/meal planner, **map
view**):
- Save/organize/smart collections → the Mind's capture + smart spaces (same
  mechanic as albo's "smart collections that fill themselves from tags").
- **Map view** → Wave 5: needs geo data per place + a tile source; offline
  maps (e.g. OpenFreeMap tiles cached owner-side) are the local-first route.
- Recipe nutrition/cook-mode/meal planner → Wave 5 (needs structured recipe
  parsing; doable offline).
- Sharing → deliberately out (single-owner local app).

## Bobby → Subscriptions

| Bobby feature (free base; $2.99 paid) | Arena implementation |
|---|---|
| Manual subscription input | Add form (name, amount, currency, cadence, next charge, category). |
| Unlimited tracking (Bobby's paid tier) | Unlimited — it's your database. |
| Payment reminders | Honest version: the "Coming up" panel (next 30 days, red ≤3 days). A local web app has no push channel; the page is the reminder. |
| Month/year cycle view | Per-month and per-year totals computed from cadence-normalized amounts. |
| Color-coded categories | Category color chips per row. |
| Multi-currency | USD/SGD/AUD/EUR/GBP/JPY per subscription. |
| Offline, no accounts, no bank | Identical philosophy — Postgres on your machine, zero network. |
| "Next charge" upkeep | `rollForward()` auto-rolls past dates forward by cadence. |

## Mailopoly → the inbox, for real (v2)

Mailopoly (AI email client: extract invoices/bookings/deliveries, draft
replies, chat over your inbox):
- **Shipped (v1)**: paste a receipt/invoice email into Subscriptions → the
  app's models extract {name, amount, currency, cadence, next_charge} →
  one-tap save. Model tier → regex floor (`$X.XX` + cadence words + date
  parsing) → honest "fill it manually" if neither finds anything.
- **Shipped (v2 — real login)**: 📬 Log into your email on
  `/subscriptions`. Owner-side IMAP (imapflow): Gmail / Outlook / iCloud /
  Fastmail presets or any custom host, App-Password auth, credentials sealed
  AES-256-GCM (`secretBox`) in the local database — never returned to the
  browser. *Scan for receipts* opens INBOX read-only, walks recent messages
  (mailparser for real MIME, multipart/alternative included), runs the same
  model→regex extraction per message, marks candidates already tracked, and
  adds the rest one-tap. Honest failure taxonomy (auth_failed /
  connect_failed / dns_failed / timeout) surfaces in the UI with an
  App-Password hint. The transport is proven against a real RFC-3501 server
  in `src/lib/emailInbox.test.ts` — no mock of your actual inbox, ever.
- **Not yet (honest)**: reply drafting and "chat over the inbox" (sending
  mail is a write operation — needs its own guardrails), and per-folder
  scanning beyond INBOX.

## Where things live

- `src/lib/mind.ts` + `src/app/api/mind/route.ts` + `src/app/mind/page.tsx`
- `src/lib/subscriptions.ts` + `src/app/api/subscriptions/route.ts` +
  `src/app/subscriptions/page.tsx`
- `src/lib/emailInbox.ts` + `src/lib/secretBox.ts` +
  `src/app/api/email/route.ts` (IMAP accounts, scan, import)
- Tests: `src/lib/mindApps.test.ts` (classification, keyword-floor honesty,
  full capture→search→space→serendipity round-trip, cadence math, CRUD,
  receipt extraction incl. the honest-none path). `src/lib/emailInbox.test.ts`
  (secret-box sealing/tamper, HTML→text, real MIME parse→extract, refused
  connection honesty, and a live ImapFlow login+scan against a minimal
  RFC-3501 server).
