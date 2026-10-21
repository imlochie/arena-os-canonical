# Continued shared media reliability, 21 October 2026

Start: owner a6f385523539cf89c232abf4c2ad3c180afa83d2, clean, remote/PR15
same. All seven exact-head hosted checks completed SUCCESS. PR18 bca22c5 is
already an ancestor: complete live diff (524 lines) contains acceptance harness,
workflow, independent decoded-frame audit and documentation, not missing media
production code. Dependencies/archive and attribution packaging already present.
Donor heads PR14 536c940 / PR16 622b78a / PR19 16a6e0b / PR20 04ea4bd unchanged.
No new merges/retargets/donor edits. Session branch is fixed by Arena; continue
on arena/331aa502-arena-os-canonical, not a new competing branch.

## P2: valid byte ranges returned the wrong audio or rejected seek requests

Original real PG/storage/HTTP-handler regression on source, passthrough stem and
native export assets: `range-before.tap`, 12 leaf assertion failures plus their
2 failed containers (13 pass/14 fail overall). `bytes=-100` silently returned
first 101 bytes instead of last 100; valid oversize-end and large suffix ranges
and uppercase units were rejected. Public release had another incompatible
parser; local-library parser was closer but lost precision on large integers.

Fix: one bounded-offset single-byte-range parser, shared by all four local file
streaming endpoints. RFC 9110 suffix/end bounds clamp BEFORE number conversion;
BigInt decimal arithmetic avoids overflow/rounding. Empty/malformed/multipart/
unsatisfiable ranges retain strict 416 behavior. No auth, catalogue, storage,
render, attribution ZIP or Agent B implementation changes. No samples changed.

Regression checks actual byte arrays, Content-Length, Content-Range and statuses
for private source/stem/export and public release, including 416 empty bodies.
`node --import ./scripts/register-src-loader.mjs --test src/lib/http/range.test.ts src/lib/waveyard/export-bundle.test.ts`:
54 pass/0 fail (`range-after.tap`); overlapping suites are not a unique-test sum.
Focused ESLint passes. Initial typecheck caught ES2017-target-incompatible bigint
literal syntax; using BigInt constructors preserves runtime semantics without
changing compiler settings. `npm run typecheck` passes after that adjustment.
Final committed-head broad/build/connected checks are recorded subsequently.

Scope: actual PG/handler/storage bytes and controlled audio, not learned inference
or full Next browser acceptance by themselves. Prior failures remain recorded.

## P1: false successful publication and corrupt public audio delivery

The publication PUT checked only a candidate's complete database status; it never
opened its object. Public release GET bypassed the verification already enforced
by private export GET. Same-size corrupt bytes could be published with HTTP200,
then publicly streamed with HTTP200/206. Missing media was also successfully
published; playback returned generic500. Injected storage unavailability was
ignored by preflight/public serving. `publication-before.tap`: 9 leaf failures,
4 failed containers (0 pass/13 fail); these are not 13 distinct product bugs.

Fix reuses verifyStoredFile before the publication/audit transaction and before
public full/ranged delivery. Exact checksum/size failures yield422, missing410,
and unacknowledged storage503. The helper now wraps failures obtaining the local
storage path as503, as it already did for failed copies/reads. No invalid-read
cleanup, job-status rewriting, asset deletion or publication metadata mutation.
Restoring the SAME exact object allows the SAME job/asset to publish/play again.

New real PG/storage/production-handler regression covers unchanged project/audit
state on failed publish, full/ranged fail-closed public reads, preservation of
complete owner jobs, and byte-for-byte repair/reuse. Combined command:
`node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/publication-integrity.test.ts src/lib/waveyard/export-bundle.test.ts`
65 pass/0 fail; `npm run typecheck` and focused ESLint pass. Initial fixture setup
used a fractional duration unsupported by the integer DB column, then an initial
nested subtest used its parent's context and was stopped; both harness failures
are retained under `.data/reliability-continuation/before/`, NOT product evidence.
The actual before/after runs use identical valid one-second owned WAV bytes.

Verification is at request preflight, not a claim of transactional locking against
an external privileged writer mutating storage after verification. This change
does not add content-hash caches or bypass existing private-export checks.

## P1: MIDI was offered/published as a playable public WAV

PublicationPanel explicitly promises a completed WAV picker and public audio
playback. Its backend picker returned every export format. A completed MIDI
passed publication validation and was served with Content-Type audio/wav, causing
an unusable public player while replacing the previous valid release.
`midi-publication-before.tap`: all three new leaf assertions fail (12 other
assertions pass, 5 failures including containers). Actual valid MIDI bytes,
checksum and metadata are used, not merely a renamed WAV.

Fix filters the completed-WAV picker and validates format on publish; rejected
MIDI cannot mutate the previous release. Legacy public MIDI references receive
409/release_not_playable with an actionable owner instruction instead of bogus
WAV bytes. Private MIDI export playback/download paths remain unchanged. The
regression confirms exact private bytes and audio/midi type remain retrievable.
Combined range/publication/export regressions: 71 pass/0 fail in
`midi-publication-after.tap`. Typecheck/focused ESLint pass. No MIDI analysis,
rendering or Waveyard preparation/PCM ownership code changed.

## P1: international filenames made valid downloads fail HTTP500

Real source/public release full and ranged downloads with `夜の演奏 🎵.wav`
reproduced four HTTP500s. Node Headers rejected the raw Unicode Content-Disposition
value as a non-ByteString. `unicode-download-before.tap`: 51 pass/6 failures
including two containers. Previously stored audio remained valid but inaccessible
as a download. No filename fixture was changed to ASCII to hide the problem.

Fix emits RFC6266/RFC8187 ASCII fallback plus filename*=UTF-8 encoded portable
name, stripping control/path characters in both, preserving international names.
Malformed UTF-16 is made well-formed rather than throwing while encoding.
Only Waveyard source and public release headers use the shared helper here;
Agent B/device-artifact/Spaces implementations are untouched. Regression verifies
header construction, decoded international names, injection controls and EXACT
full/suffix audio bytes. Combined focused regressions: 78 pass/0 fail in
`unicode-download-after.tap`. Typecheck and focused ESLint pass.

## P1: private source/stem playback certified path presence, not asset identity

Following the public/private comparison, actual source and passthrough stem GETs
also served same-size corrupt audio with HTTP200/206. Missing and transiently
unreadable objects produced generic500. `private-playback-before.tap` records
12 failed leaf assertions plus 8 containers (56 other assertions pass).

Fix reuses the existing bounded streaming checksum/size verifier before source/
stem delivery and preserves distinct422/410/503 errors. Read failure cannot
rewrite job/bank/source state or delete user audio. A repaired SAME storage object
serves the SAME asset id and checksum without a duplicate job or replacement.
Full and suffix requests and exact repaired bytes are covered for both assets.
Final combined focused command:
`node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/export-bundle.test.ts src/lib/waveyard/publication-integrity.test.ts src/lib/http/range.test.ts src/lib/http/download.test.ts`
97 pass/0 fail, plus typecheck and focused ESLint pass. No complete-file Buffer
or hash cache was introduced; verification uses streaming reads but adds a full
identity-read preflight to each request, as private export media already did.
Large-source seek latency has not been benchmarked; external privileged writes
after verification remain outside the preflight guarantee.
