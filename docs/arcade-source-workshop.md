# First supported source/mod adapter

The Source workshop in `/arcade` acquires four real files from the official
`gabrielecirulli/2048` repository at
`478b6ec346e3787f589e4af751378d06ded4cbbc`, verified as MIT. Full license text,
source URLs, exact revision, hashes, source bodies, architecture notes, original
and modified manager hashes and a reviewable unified diff remain in the
downloadable JSON package and existing Artifact object/revision storage.

Supported modification: **2–8 initial tiles**, replacing one exact constructor
anchor. An upstream mismatch fails closed; it never adjusts the pin or guesses
at conflicts. `git apply --check`/replay and original/modded browser constructor
and restart counts are separate adapter acceptance checks. Acquisition itself
reports runtime **not run**; a historical CI pass is not labelled a per-request
gameplay execution receipt.

The downloadable offline preview runs real upstream GameManager/Grid/Tile
through Arena's small canvas, keyboard and memory-storage presentation adapters.
It is not the official 2048 UI, does not preserve playing-state across reloads,
and is not automatically installed/published into the game catalogue. It retains
MIT notice. No arbitrary upstream URL, archive extraction, dependency install,
DRM, general reverse engineering or unrestricted host execution is provided.
The downloaded JSON package is data; the HTML preview executes only when the
user explicitly opens it. Arcade's acceptance uses the opaque sandbox and
denied network, not Node eval/vm.

Public acquisition uses the existing public-destination/redirect policy,
fixed URLs, no redirects, a 10-second request deadline, 64KiB/file bounds and
four SHA-256 pins. Local Mode blocks egress; Ephemeral Mode does not persist the
package. Failed persistence returns a download warning, not a saved result.

Run `node --import ./scripts/register-src-loader.mjs --test
tests/acceptance/arcade-source.test.mjs` with Chromium installed. This test
requires real public source availability and must fail honestly if unavailable.
