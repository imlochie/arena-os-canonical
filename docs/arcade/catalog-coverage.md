# Open-source catalog coverage

Arcade searches these discovery sources rather than treating their entries as
built-in games:

- https://github.com/bobeff/open-source-games — 157 parsed listings in the live check.
- https://trilarion.github.io/opensourcegames/ — 1,610 game entries, excluding its engine/tool index.

Counts are upstream snapshots, not playable-game counts, and the catalogs overlap.
No catalog license hint substitutes for checking the acquired repository/license.

## Current acquisition path

`Arcade → Import and emulate → accept rights → catalog search → Choose → repository review`

Authenticated POST endpoints:

- `/api/arcade/import/catalog/search`: query, catalog and offset; 30 results per page,
  cached fixed-source discovery with partial-outage reporting.
- `/api/arcade/import/catalog/resolve`: known catalog entry ID to its labelled source
  repository; never fetches an arbitrary caller-supplied URL.

GitHub selections enter the existing pinned repository review. Browser projects
continue through immutable inspect/acquire and offline packaging. Native Godot/SDL
projects retain their approved recipes. Other projects with recognized native
build manifests can review qualifying Windows portable releases; this is not
arbitrary C++ source-build support or proof that a project is a game.

An oversized or unsafe recursive repository tree may fall back to bounded root
metadata for release review. Such a review explicitly disables source acquisition;
it does not silently package a partial source tree.

Browser packaging keeps author-credit text but neutralizes outgoing navigation.
Local stylesheet imports, including unquoted `url(...)`, are flattened with their
media qualifiers. The final offline safety validator is unchanged: remote assets,
network code, embedded documents and unsafe navigation remain blocked.

## Evidence and acceptance

Live service calls resolved Trilarion's 2048 entry to
`https://github.com/gabrielecirulli/2048`, assessed its MIT license and acquired
27 files pinned at `478b6ec346e3787f589e4af751378d06ded4cbbc`.

The browser acceptance used these real captured service results through intercepted
API transport, not an authenticated HTTP end-to-end run:

1. Accept rights, search for 2048, choose its OSGL entry.
2. Continue browser review, inspect and import the reviewed repository.
3. Scroll to and focus the actual `Playable game:` iframe, not a startup probe.
4. Press arrow keys; require visible tile/score changes. Observed: two tiles became
   seven and score reached 16.
5. Confirm the imported frame has no active external attribution hyperlinks.

Backend parser/repository tests and frontend offline-navigation, stylesheet and
attribution tests pass. API, frontend and generated-library type checks pass.

## Still not universal game support

- Non-GitHub sources are linked honestly but cannot yet use this acquisition provider.
- Unknown/missing SPDX classification can block a genuine open-source project.
  Live OpenTTD review demonstrated this; catalog metadata must not override it.
- Installers, unsupported archives, multi-executable layouts and packages exceeding
  existing portable-release limits need additional reviewed recipes/entrypoint handling.
- Source ports and engines may require separately owned game data, dependencies or
  external runtimes. A code license does not supply those assets.
- Some games need build toolchains outside the currently approved recipes.
- Native runtime execution, sandbox compatibility and gameplay remain deferred to
  the final Windows verification pass. Catalog discovery and installation metadata
  are not evidence of successful Windows gameplay.
