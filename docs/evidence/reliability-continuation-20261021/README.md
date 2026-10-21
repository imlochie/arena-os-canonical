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
