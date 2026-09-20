# Storage

Waveyard writes all audio through `StorageProvider`.

- `local`: mounted local filesystem for single-machine/self-hosted development.
- `s3`: AWS S3 or any S3-compatible endpoint.
- `minio`: an S3-compatible deployment choice configured with the same adapter.

Object keys are UUID-derived and project-scoped. Original names are metadata only and never become paths. Private download endpoints authorize the request before creating a signed URL or streaming a local object. Uploads are untrusted: paths are sanitized, size/type limits applied, and temporary paths remain isolated from public serving roots.

No storage provider credentials appear in browser code.
