# Arena

A private, local-first AI workspace: Core runtime, Spaces, Arcade, Waveyard
(music), Studio (media generation) and a Windows desktop app.

> **Proprietary. Do not copy or reuse.** All rights reserved. See [LICENSE](LICENSE).
> Third-party components keep their own licences
> ([notices](desktop/THIRD-PARTY-NOTICES.md)).

**Working on Arena (human or AI agent)? Start with
[docs/HANDOFF.md](docs/HANDOFF.md).** It holds the current status, priorities,
rules and the ledger of every branch and PR. Keep it updated.

## Layout

pnpm workspace on Node 22+ and pnpm 10.26.1.

| Path | Contents |
| --- | --- |
| `artifacts/arenaforge` | Vite/React frontend |
| `artifacts/api-server` | Express API (Waveyard routes under `src/imported/waveyard`) |
| `lib/arena` | Shared engine (`@workspace/arena`): Waveyard, runtime, security |
| `lib/db` | Database schema and access |
| `desktop` | Electron/Windows packaging, native hosts, acceptance scripts |
| `scripts` | Smoke tests and repo tooling |
| `docs` | Design notes, audits, handoff |

## Common commands

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/db run push            # dev schema
node --test desktop/<name>.test.mjs             # desktop unit tests
pnpm --filter @workspace/scripts exec tsx --test ../<path-to>.test.ts
```

Windows installer (x64, MSVC + MSYS2 toolchain): `desktop/Start-Windows.ps1`
(see [desktop/README.md](desktop/README.md)). CI: `.github/workflows/windows-package.yml`.
