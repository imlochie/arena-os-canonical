# Waveyard Bug & Security Sweep — Delivery Report

**Scope:** full bug and security sweep of the shipped surface, plus Windows-readiness
verification, following the mandate wave (`d3f2b69`). Everything below was found by
inspection or live probe, fixed, and re-proven — nothing is claimed from static review
alone. Battery after the sweep: **1125/1125** (1110 + 9 markdown + 6 request-gate),
`tsc --noEmit` clean, eslint clean, desktop-mode production build clean, standalone
server live-probed.

**Environment note (13th platform re-clone, repaired in place):** HEAD had been reset to
the base commit with the working tree intact; repaired via `git reset --mixed` to
`origin/arena/01a10c30-arena-os-canonical` (`968e286`), restored the three
`desktop/build/` files the snapshot excludes (git-tracked, restored from the commit),
and re-committed the wave as `d3f2b69` (tree identical to the lost `6e3161c`).
`node_modules` was rebuilt with `npm ci --ignore-scripts` (the onnxruntime-node
postinstall pulls from api.nuget.org, which this sandbox blocks; the native bindings
ship inside the npm tarballs, so only exec bits and soname symlinks needed restoring —
done and verified by the passing real-ORT test).

---

## 1. Security findings and fixes

### 1.1 XSS in the markdown renderer (FIXED)
`src/components/Markdown.tsx` fed `dangerouslySetInnerHTML` from a renderer whose
`esc()` escaped `& < >` but **not quotes**, and whose link/image regexes injected the
URL into `href="…"`/`src="…"`. Two exploitable vectors on every surface that renders
markdown (battles, collabs, classroom, assistants…):
- attribute breakout: `![x](https://a" onerror="alert(1))` produced a real
  `onerror` handler;
- scheme injection: `[click](javascript:alert(1))` produced a live `javascript:` link.

**Fix:** the renderer moved to `src/lib/markdown.ts` (pure, unit-tested) with
(1) `esc()` escaping `& < > " '`; (2) `safeUrl()` — an allowlist gate (http/https/mailto
and relative URLs only; control characters, quotes, backslash, and scheme-relative
`//` rejected — browsers strip `\t`/`\n`/`\r` inside URLs, which would otherwise
smuggle `java\tscript:`); (3) URLs judged in their **original** form (un-escaped
first) and re-escaped on output; unsafe links render as literal text. 9 tests,
including both vectors, tab-smuggling, `data:` URLs, and the ampersand round-trip.

### 1.2 Browser drive-by CSRF against the local server (FIXED)
The desktop runtime binds `127.0.0.1:<random port>` — but any *website* open in the
user's browser can still fire requests at that port. JSON POSTs force a CORS preflight
(never approved), yet **simple content types** (multipart/form-data, text/plain) are
sent without preflight: a malicious page could upload junk audio or create projects in
the local library.

**Fix:** `src/proxy.ts` (Next 16's convention; `middleware.ts` is deprecated) +
`src/lib/security/local-request-gate.ts` (pure, 6 tests): mutations are rejected when
`Sec-Fetch-Site: cross-site` or when `Origin` does not match `Host`; reads,
same-origin, and non-browser clients (curl, node fetch, the worker, Playwright's
APIRequestContext, the desktop acceptance harness) always pass. **Live-proven on both
the dev server and the standalone desktop build:** evil-origin POST → 403,
cross-site POST → 403, same-origin POST → 201, no-origin POST → 201, cross-origin GET
→ 200, pages → 200.

### 1.3 Unauthenticated routes (FIXED)
- `GET /api/waveyard/processing-status` and `GET /api/desktop/diagnostics` lacked the
  `requireUser` guard every other waveyard route has. Both now call it (resolves to
  the local owner; zero behavior change locally, correct posture in any hosted
  deployment). Diagnostics was audited for leaks: it reports env var *names* and
  health states, never credential values.

### 1.4 Unbounded import reads (FIXED)
`ConnectedLibraries` read arbitrary dropped files as text before parsing (a
mis-dropped multi-GB file would be fully read into memory). Imports are now capped at
64 MB with an honest error; the parsers were already limit-enforcing.

### 1.5 Audited and found sound (no change needed)
- **Assets route**: UUID-validated ids, DB-looked-up storage keys, project-role check,
  sanitized `Content-Disposition`, correct 206 range handling.
- **Uploads route**: extension allowlist, 1-byte–500 MB bounds, model allowlist,
  device regex, editor role, checksum + honest probe fallback.
- **Storage layer**: `safeLocalPath` normalizes and rejects `..` escapes with
  platform-`sep` awareness; all disk keys are server-generated UUIDs; extension
  stripped to alphanumerics.
- **drizzle `sql\`\`` correlated-subquery trap** (the V6 bug class): swept every
  `sql\`\`` use in `src/` — the accounts route was the only select-list subquery and
  is already fixed; all other uses are single-table WHERE clauses (safe rendering).
- **Service worker**: never caches `/api/` (app shell only).
- **Secrets**: no tracked `.env`, no key/credential patterns in `src/`, `scripts/`,
  or `desktop/`. Desktop DB password is a random 24-byte hex in a 0600 file.
- **Electron shell**: frame-navigation policy is origin-equality based; only the local
  app origin + splash can render.

## 2. Bug findings

- **Battery regression, root-caused to the environment, not code:** after the
  dependency reinstall, 23 library-service tests failed with `ffprobe is not
  available` — the `@ffprobe-installer`/`@ffmpeg-installer` postinstalls (exec-bit
  chmod) were skipped by `--ignore-scripts`. Restoring the exec bits brought all 23
  back; final battery 1125/1125. The binaries ship inside the npm tarballs — **no
  download was ever needed** (Windows unaffected: same mechanism, and the desktop
  packaging sets `ARENA_FFPROBE_PATH` to bundled binaries anyway).
- **Middleware deprecation:** Next 16.3.8 warned that the `middleware` convention is
  deprecated. Migrated to `proxy.ts`/`export function proxy` (the new documented
  convention) and re-probed the gate on the standalone build.
- No other functional bugs found in the mandate-wave code on fresh-eyes review
  (drop-flow error paths, tab wiring, CSV limits, sync-on-open guard, stem-sum
  identity — all re-verified by the battery and live probes).

## 3. Windows readiness

- **Desktop-mode production build** (`ARENA_DESKTOP_BUILD=1`): succeeds; proxy
  registered; onnxruntime-node kept external with win32/x64 bindings present in the
  traced tree; repo-junk and self-packaging excludes intact.
- **Standalone server** (the artifact Windows runs): booted from
  `.next/standalone/server.js` against a real PostgreSQL with
  `ARENA_DESKTOP_MODE=1 NODE_ENV=production` — pages serve, the processing-status
  route reports `in-process` with real broker stats, and the request gate behaves
  identically to dev (403/201/200 probes above).
- **Path handling:** no string-concatenated paths in the waveyard server code;
  storage uses `node:path` primitives with `sep`-aware traversal rejection;
  `sanitizedFilename` strips path characters and NULs (and filenames never become
  disk paths — UUID keys). Embedded-postgres and installer binaries resolve
  per-platform (`win32-x64` package present; `desktop/runtime/config.ts` handles
  Windows' null socket dir).
- **Acceptance harness:** speaks no HTTP with browser headers (no Origin to trip the
  gate).
- **Still owner-side (unchanged, honest):** the real Windows acceptance protocol
  (`docs/windows-acceptance.md`) must be executed on actual Windows — nothing here
  claims it. Real Kim_Vocal_2.onnx weights remain owner-side (huggingface.co is
  connection-blocked from this sandbox in every form).

## 4. Final state

- Battery **1125/1125** (≈624 s), tsc clean, eslint clean on all touched files.
- Live evidence: dev server + standalone desktop build both probed (gate, routes,
  pages); proof rows cleaned from the dev database afterwards.
- Committed locally on `arena/01a10c30-arena-os-canonical` (not pushed, per the
  standing rule).
