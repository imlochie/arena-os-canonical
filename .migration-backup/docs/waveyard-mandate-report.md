# Waveyard Mandate Wave — Delivery Report (§16)

**Scope:** Arena/Waveyard full-project realisation mandate — "from architecture-complete to
product-proven." This wave covers the runtime-honesty slice, the Layer D real-inference proof,
the first-session experience (cold open + progressive studio), library-vision completion
(CSV import + sync-on-open), and one real production bug found and fixed by live verification.

**Tree:** branch `arena/01a10c30-arena-os-canonical`; base `968e286` (battery 1098/1098).
This wave: **1110/1110 passing** (+6 runtime policy, +1 real-ORT, +5 CSV import), `tsc --noEmit`
clean, eslint clean on every touched file. Local commit only — **not pushed**, per the mandate's
no-publish rule.

---

## 1. What changed

### 1.1 Runtime-mode policy (P0 reliability)
- **`src/lib/waveyard/worker-local/runtime-policy.ts`** — `resolveProcessingMode(env)`:
  `REDIS_URL` → external worker; `WAVEYARD_LOCAL_WORKER=0/1` override;
  `ARENA_DESKTOP_MODE=1` or `NODE_ENV=development` → in-process; else none.
  6 unit tests (`runtime-policy.test.ts`).
- **`src/app/api/waveyard/processing-status/route.ts`** — real broker stats over the queue
  tables (per-queue depth, mode, worker uptime). No vocabulary leaks: the response says
  what is *processing* and *how*, never "job queue" UI-speak.
- **`ProjectWorkspace.tsx`** — honest processor notice banner rendered from that route
  (in-process / external / unavailable), so the user always knows where work runs.
- `instrumentation.ts` / `worker-local/index.ts` boot through the policy.

### 1.2 Layer D — real ONNX Runtime proof (P0 proof obligation)
- **`separation-fixtures.ts`** (new, non-test) — the e2e harness extracted so both the fake-
  session suite and the real-ORT suite share one fixture: PGlite + canonical desktop
  migrations + real local storage + a real WAV source asset + job rows.
- **`separation-real-ort.test.ts`** (new) — hand-crafts a *passthrough* ONNX ModelProto
  (pure-TS protobuf writer, ~300 bytes: one Identity node, `input` [1,4,dimF,dimT] f32),
  then runs the **production** pipeline against it via a real
  `ort.InferenceSession.create(file, { executionProviders: ["cpu"] })`:
  PGlite → job → STFT → real ORT inference → overlap-add → ISTFT → WAV persist → stem rows.
  Assertions: job `complete`/`resolvedDevice cpu`/`errorCode null`; two stem rows with
  exact WAV sizes; **primary reconstructs the source through the whole real chain at
  SNR > 60 dB**; **stem-sum `compensate·primary + secondary = mix` within 5e-3** after
  16-bit storage. Passes 1/1 (~29 s).
- **`separation.test.ts`** — slimmed to the shared harness (8/8 still pass). The canonical
  stem-sum identity is now written once: `secondary = mix − compensate·primary`.

### 1.3 First-session experience (P2)
- **Cold open — drag a song anywhere** (`MusicHome.tsx`): a surface-wide drop target with a
  full-screen overlay ("Drop to separate"). One audio file → project created (default
  separation) → upload → straight into the workspace watching stems appear. Hero copy now
  states the promise: drop → stems on your machine → the player.
- **`BuildProject.tsx`** — options folded behind one toggle (separation target + authorized
  links). The cold form is title + drop + BUILD.
- **Studio tabs** (`StudioCore.tsx`) — inside the Studio presentation: **Edit / Analyze /
  Showcase** with genuine unmounts per tab. The audio graph lives in `useStemTransport`
  (StudioCore state), so switching tabs never stops playback; the master tap stays a lazy
  `MediaStreamAudioDestinationNode`, null before first play. Analyze actions that produce
  arrangement edits (use-for-slice, arrange, accept meeting point) jump to Edit.
  Play and Visual remain the listener-facing presentations above the tabs.
- **Nav parking** (`WaveyardNav.tsx`) — Music / Sessions / Studio lead; Discover moved to a
  quiet secondary row (kept, tested, out of the default path).

### 1.4 Library vision completion (V6.1)
- **`parseCsvSnapshot`** (`library-sync.ts`) — RFC 4180 CSV import (quoted fields, commas,
  newlines, escaped quotes, BOM, CRLF). Accepts **our own export** (perfect round-trip),
  **Exportify**, and **TuneMyMusic** headers; m:ss and h:mm:ss clock durations; ISRCs go
  through the same honest `parseIsrc` (invalid → null, never guessed). Playlist column
  groups in first-seen order. 5 new tests (14/14 in the file).
- **`ConnectedLibraries.tsx`** — the import button takes JSON *or* CSV; **sync-on-open**:
  the panel lands straight in the freshest snapshot with its diff already computed
  (once per mount, never stomping a user choice).
- **`accounts/route.ts`** — `latestSnapshotId` for the auto-open… which found a real bug:

### 1.5 Real bug found and fixed (claims → evidence)
The V6 accounts route used drizzle `sql\`\`` templates with interpolated columns inside
correlated subqueries. Drizzle renders those **unqualified** (`where "account_id" = "id"`),
so the correlation silently matched each snapshot's *own* id — every account stat
(`snapshotCount`, `lastSyncAt`, `trackCount`) read 0/null forever, while unit tests stayed
green because the routes had never been live-verified with data. Fixed with explicitly
aliased literal SQL and **proven live**: account row now reports count 1, sync time, track
count, and the correct latest snapshot id; the full CSV chain (parse → store → GET with
diff → export → delete) was exercised against the running server, then the proof data was
cleaned up.

---

## 2. What works (evidence)
- **Battery:** `node --run test` → **1110 pass / 0 fail** (≈510 s). Layers: A (unit),
  B/C (pipeline incl. PGlite e2e), D (real-ORT smoke, new), plus policy + CSV suites.
- **tsc / eslint:** clean on the whole tree.
- **Live dev server:** boots in ~480 ms; worker up via the policy (5 queues); processing-status
  route returns real broker stats; `/waveyard` renders the new hero + drop surface; parked nav
  present; CSV chain proven end-to-end through the real API (see 1.4/1.5).

## 3. What failed / was attempted and abandoned
- **Real Kim_Vocal_2.onnx download:** unobtainable this session. `huggingface.co` is
  unreachable at the connection level from this sandbox in *every* form (resolve/, blob/,
  cdn-lfs/, even the homepage — while npm and github respond). The earlier network map's
  "HF blob ✓" no longer holds. No weights were fabricated; the registry's sha256 gate
  (`ce74ef3b…`) stays authoritative, so real weights close only via the owner's machine
  (desktop seeding path or a network where HF resolves).
- **Test-authoring dead ends (internal):** a from-scratch real-ORT e2e drifted (discarded);
  the reliable pattern was extracting the shared harness. A bulk import-header edit ate
  three still-used imports (caught by tsc, fixed). Double-releasing the ORT session and
  putting `compensate` on the secondary stem both produced honest failures before the
  correct forms.

## 4. What remains unverified (honest list)
- **Separation quality with real weights** — Layer D proves the *signal path* end-to-end
  (real ORT, real storage, real persistence, reconstruction and stem-sum math), not
  vocal/instrumental quality. That proof requires the real model file (see 3) — owner-side
  by design.
- **Windows desktop acceptance** — protocol unchanged, still requires a real Windows run
  (`docs/windows-acceptance.md`); nothing here may be claimed as desktop acceptance.
- **Browser-level interaction** for the drag-anywhere cold open and tab switching — SSR
  output and component code verified; CI's Playwright e2e remains the automated cover.
- **Live Apple / YouTube / Spotify library flows** — adapters and PKCE are in, but live
  sync needs the user's developer credentials (Spotify client ID flow is wired in-UI).
- **Dev-database environment note:** this session booted a fresh embedded PostgreSQL
  (binaries already vendored) and applied the schema; data dirs live outside the repo.

## 5. Discovered (worth keeping)
- Drizzle's unqualified column rendering inside `sql\`\`` subqueries — a silent-correlation
  trap for any correlated stat; grep your `sql\`\`` uses if stats look suspiciously empty.
- The audio-graph-survives-unmounts architecture (graph owned by the transport hook, not
  panels) is what makes progressive-disclosure tabs safe — it held without modification.
- stem.fm's moat is a licensed catalog, not tech: Spotify previews are dead for third
  parties, Apple needs a token, YouTube has no music API — metadata-in/audio-out (local
  files + CSV/library metadata) is the only fully-workable third-party surface, and it is
  exactly what this wave completed.

## 6. Final state
- Branch `arena/01a10c30-arena-os-canonical`, one local commit ahead of `968e286`
  (not pushed). Working tree clean after commit except intentionally untracked dev
  artifacts. Dev server left running as a live preview of the cold-open and tabs.
