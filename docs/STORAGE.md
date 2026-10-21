# Storage

Waveyard writes all audio through `StorageProvider`.

- `local`: mounted local filesystem for single-machine/self-hosted development.
- `s3`: AWS S3 or any S3-compatible endpoint.
- `minio`: an S3-compatible deployment choice configured with the same adapter.

Object keys are UUID-derived and project-scoped. Original names are metadata only and never become paths. Private download endpoints authorize the request before creating a signed URL or streaming a local object. `?download=1` requests attachment disposition; authenticated range playback remains available without it. Uploads are untrusted: paths are sanitized, size/type limits applied, and temporary paths remain isolated from public serving roots.

Waveform peak documents are derived private JSON objects under the `waveform` key category. Their small metadata/checksum is recorded in PostgreSQL, but the object key is redacted from browser-facing project APIs. The waveform delivery route makes a bounded server-side read only after project authorization and validates the document before responding.

No storage provider credentials appear in browser code.

## Studio export downloads (2026-10-21)

Studio's export `media?download=1` returns a bounded ZIP containing the **exact
published WAV or MIDI**, `RIGHTS.txt`, and `export-manifest.json`. Preview/range
requests without `download=1` remain raw media. The existing disk-backed verified
ZIP writer checks every media byte against the published checksum and size
before returning a response; no audio is recompressed and no partial archive
is served. Its existing limits apply: 2 GiB total, two concurrent archives,
abort-aware cleanup. Portable notices/manifest are each bounded to 4 MiB.

New manual and automatic remix versions capture source acquisition notices in
that existing immutable version snapshot. Every referenced source is covered,
including muted lanes conservatively. Parent source bytes/checksums remain
separate from conversion output identities; native conversions retain original
acquisition notices and a checksum-bound parent link. A malformed conversion
acquisition blocks library completion and retains verified output for repair.

A legacy version without captured notices resolves the current acquisitions
and labels the basis `legacy-current-acquisition`; it does not claim historical
licence evidence. Missing/malformed saved notices are not silently replaced.
A MIDI analysis source outside the arrangement is additionally identified by
its immutable job source ID/checksum, with its notice basis explicitly labelled
`midi-analysis-current-acquisition`. These extra MIDI notices are not claimed to
have been captured at the original version's creation time.

Unknown rights stay **unknown**. Embedded lyrics, a local upload, a subscription,
or successful conversion is not licence verification or permission to share.
Recorded notices are retained, not legal clearance. Internal object keys, volume
paths and arbitrary acquisition metadata are excluded; source URL credentials,
query strings and fragments are removed from the portable URL field.

Export publication and unsuccessful-attempt cleanup share the export-job row
lock. A lost COMMIT/reporting acknowledgement cannot remove media referenced by
an export, source or stem row. Only this attempt's job-scoped, proven-unreferenced
key can be removed. Lookup/lock/storage failures retain the output and, when SQL
is available, expose `publication_unknown` / `reconciliation_required`. Cancelled
and completed jobs cannot be resurrected by late progress/error writes.
Unknown objects remain under `projects/<project>/export/<export-job>/<nonce>` for
explicit reconciliation; this does **not** implement automatic orphan discovery
or prove abrupt export-process crash recovery on every platform.
