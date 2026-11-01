# Mod Workshop: actual capability and boundaries

## Workflow
1. Import an authorized HTML/ROM game, or install a managed native game.
2. In Arcade → Mod Workshop, choose its exact base, create an independent profile, and leave save sharing off unless intentionally needed.
3. Confirm rights and choose a local `.json` mod package, or a public GitHub repository/release-tag URL containing `arcade-mod.json`.
4. Review exact input/output hashes, permissions, dependency order and license notices. Commit only the reviewed proposal.
5. Activate and Play. Browser games use the existing sandbox/player with a separate save namespace. Native games use a materialized immutable overlay installation and separate writable profile/AppContainer identity; a live Windows containment probe is still mandatory.
6. Disable/remove one mod through another preview. Rollback reconstructs the last reviewed content/settings from the immutable base. Saves are deliberately not reverted.

Browser mod playback is an explicit snapshot: after editing a profile, press Play again to load its new content. Existing imported source revisions and base-game controls remain separate.

Disabled installed packages remain in the profile controls and saved preference order; re-enable them without reimporting. Portable backups retain those disabled packages too. Restoring a backup into a profile with a different save-sharing scope is rejected before any write: create/select a profile with the matching isolated/shared setting instead. Restore never silently changes save ownership.

## Package contract
Shared implementation: `lib/arena/src/lib/games/mod-workshop.ts` and `mod-workshop-engine.ts`.
Example creation: `scripts/arcade-workshop-fixture.mjs` exports an original HTML coin fixture and a real IPS package, never a commercial ROM.

Envelope: `{ manifest, files: { "payload.path": "<base64>" } }`.
Manifest requires `schema: "arena.arcade.mod"`, `schemaVersion: 1`, safe `id`, semantic `version`, `name`, `license: {spdx,text,redistributable}`, `source: {kind,url?,revision?}`, exact `base: {id,version,files}`, `adapter`, `permissions`, `requires`, `conflicts`, `after`, `settings`, `operations`, and SHA256 `payloads`.

The UI exposes the exact base identity, version and target paths. Browser HTML uses `game.html`; NES uses `game.nes`; CHIP-8 uses `game.ch8`; other emulator ROMs use `game.<system>`. Native paths come from the verified managed install descriptor. `"absent"` explicitly declares newly added targets.

Operations:
- `replace`: declared asset or script bytes with input/result SHA256.
- `ips`: actual IPS records/RLE/EOF/resize with mandatory wrapper input/result SHA256.
- `bps`: actual BPS actions with source/target/patch CRC32 and wrapper SHA256.
- `config-json`: a JSON template with whole-value `"{{settings.key}}"` placeholders, substituted as typed values without evaluation. Settings have typed defaults and optional numeric bounds.

Each operation has `target`, `payload`, `baseSha256`, and (except generated config) `resultSha256`. Overlapping files need explicit `afterMod` and the preceding output hash; no silent last-write-wins. Dependencies use exact/`*`/caret/tilde/comparator ranges, resolve deterministically, and reject missing versions, cycles and conflicts.

## Deliberate limits
- UPS, xdelta and framework/plugin loaders are **unavailable**. No generic installer hook or executable replacement is run.
- Browser HTML remains a self-contained offline document. Multi-file configurations/filesystem overlays are native-only, not fake browser filesystem support.
- Native file overlays are not a replacement for game-specific plugin loaders. A game must actually consume the declared assets/config/scripts.
- 8 profiles/game, 32 retained packages, 24 MiB package JSON inventory, 64 MiB modified working set, 8 rollback snapshots/profile. Native untouched base files are streamed/copied, not all loaded into memory. Atomic activation temporarily needs the retained old install plus new staging; reserve and total managed disk budget are checked.
- Browser state and package writes share an IndexedDB transaction with the original shelf's stale-write check. Native state uses an exclusive per-game write lock, staged immutable generations and an atomic index switch. An interrupted operation leaves the previous generation authoritative. Dead recorded lock owners can be recovered; an ambiguous empty lock fails closed and needs explicit recovery after closing other instances.
- Private browser profiles never leave the machine automatically. Portable exports contain selected **mod** payloads only when explicitly redistributable. Base bytes and saves are never included. Entire ROM replacement payloads are excluded even when labeled redistributable. Nonredistributable packages become pinned requirements; restore fails until their exact licensed local packages exist.
- Rights declarations are not independent legal verification of every asset. Repository license files and fetched package bytes are checked against an immutable Git commit. Custom/local payload permissions remain the package author's and importing user's responsibility.

## Verification ledger
- `node scripts/arena-smoke.mjs --mod-workshop-only`: real IPS/BPS, typed config/assets/scripts, checksum rejection, deterministic dependencies/cycles/overlaps, two independent profiles, simulated interrupted/stale writes, exact rollback, portability and restricted exclusions.
- `desktop/arcade-workshop.test.ts`: actual temporary-directory staging, unchanged base files, isolated save-context selection, removal/rollback, generation cleanup, and unlisted-file refusal. Its host is simulated: **not Windows execution or gameplay evidence**.
- Existing native-control tests retain fail-closed unsupported-host behavior. Desktop controller bundles through esbuild.
- Browser pass: imported the original coin fixture through the actual UI; Profile A played the visibly modified game and retained 2 coins; independent Profile B started at 0 and retained its own coin. After a full page reload A still had its modified game and 2 coins. Reviewed removal restored original visuals without resetting A's save; rollback restored modified visuals with that save intact. A distinct bad-checksum package was rejected without mutation. No new page errors were captured. A small 390px repository-row overflow was found and its row now stacks on narrow screens.
- Repository-intake unit test checks pinned Git blob verification and license/source recording using a deterministic transport fixture. The registered HTTP route rejects unauthenticated requests (401). This is not a claim that an arbitrary public mod repository can be imported without the declared package format.

Windows LPAC behavior, real native-game consumption of modded files and device-specific runtime compatibility remain for the final Windows pass, not established by Linux tests.
