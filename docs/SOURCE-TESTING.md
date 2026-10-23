# Reproducible complete source suite

Run `npm ci` and **`npm test`** from the repository root. For an existing `--ignore-scripts` install, the runner hydrates only already-installed PostgreSQL symlinks and native FFmpeg/FFprobe permissions; it never downloads tools or models.

Arcade custom-code publication security tests also exercise real Chromium.
Install it once with `npx playwright install chromium`, or set
`ARENA_ARCADE_CHROMIUM_PATH` to an installed executable. CI installs the browser
explicitly; missing browser verification is not silently mocked or skipped.

`npm test` now invokes `scripts/test-source.mjs` through the existing TS loader. It:

1. Fingerprints starting commit and working-source bytes using the existing staged-identity helper.
2. Provisions a NEW temporary embedded PostgreSQL16 cluster from the pinned platform package, on an ephemeral loopback port. It deliberately ignores DATABASE_URL/.env so test-owned table clearing cannot touch a developer database.
3. Applies **canonical desktop SQL migrations**, failing nonzero on any startup/schema error.
4. Runs ALL original `src/**/*.test.ts`, `desktop/**/*.test.ts`, `scripts/lib/*.test.mjs` files, serially (`--test-concurrency=1`). Existing legacy PostgreSQL suites delete whole shared tables; serialization prevents them racing. No mocks, skips or removed assertions substitute for PostgreSQL.
5. Tees raw TAP to stdout/stderr and `.data/acceptance/source-suite/<dated-run>.tap`; writes atomic dated JSON checkpoints (`starting`/`testing`/`passed`/`failed`) with exact commit/source digests, duration, exit and final TAP totals. Override only the evidence directory with `ARENA_SOURCE_EVIDENCE_DIR`.
6. Stops its owned cluster and removes its temporary data on completion/error. Startup failures retain bounded actual PostgreSQL diagnostics. It forwards SIGINT/SIGTERM to the test child. SIGKILL cannot execute application cleanup; an incomplete checkpoint is **not** a successful test result and the next invocation creates a fresh cluster.
7. Fails nonzero if tests fail, cleanup fails or source changes during verification. Never commits during a running verification.

The old command (`node --import ./scripts/register-src-loader.mjs --test ...`) relied on a separately started PostgreSQL service and schema. CI provided that service, but a fresh local workspace did not; tests therefore reported `PG required`. The loader's port1 placeholder intentionally prevents accidental connections and is not a PostgreSQL fixture. `scripts/environment-restore.mjs` restores a persistent development database, not an isolated source-suite invocation; the new runner reuses the existing `tests/helpers/mission-postgres.ts` fixture rather than installing another database stack.

Focused browser/audio acceptance and real PostgreSQL+Redis/BullMQ A7 acceptance remain separate commands/jobs. Their successes do not replace complete-source verification. Node/browser results do not establish Electron or genuine model inference.

## Model resume evidence

`node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/separation/seed*.test.ts`

`seed-http.test.ts` controls an actual loopback HTTP server; byte/validator/range logs and installed SHA-256 are emitted into TAP. A SIGKILL subprocess test checks the persisted prefix, starts TWO new processes, and asserts exactly one range transfer for only the remaining bytes. All bytes are explicitly synthetic provisioning fixtures, never installed as genuine models. `seed-route.integration.test.ts` uses real PostgreSQL + actual model seed/status handlers with isolated fixture registry overrides; it verifies a `stems_4` request installs all four prerequisite files, not that ONNX inference succeeds.
