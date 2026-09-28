# Storage

Waveyard writes all audio through `StorageProvider`.

- `local`: mounted local filesystem for single-machine/self-hosted development.
- `s3`: AWS S3 or any S3-compatible endpoint.
- `minio`: an S3-compatible deployment choice configured with the same adapter.

Object keys are UUID-derived and project-scoped. Original names are metadata only and never become paths. Private download endpoints authorize the request before creating a signed URL or streaming a local object. `?download=1` requests attachment disposition; authenticated range playback remains available without it. Uploads are untrusted: paths are sanitized, size/type limits applied, and temporary paths remain isolated from public serving roots.

Waveform peak documents are derived private JSON objects under the `waveform` key category. Their small metadata/checksum is recorded in PostgreSQL, but the object key is redacted from browser-facing project APIs. The waveform delivery route makes a bounded server-side read only after project authorization and validates the document before responding.

No storage provider credentials appear in browser code.
