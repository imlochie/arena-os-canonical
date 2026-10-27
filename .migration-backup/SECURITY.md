# Security Policy

## Current posture

Waveyard is pre-release software. Do not expose a development deployment to untrusted users until authentication, authorization, rate limiting, upload limits, signed media access, dependency review, and the full test matrix have been verified.

## Report a vulnerability

Use the repository's private security reporting channel when configured, or contact the project owner privately. Do not open a public issue with exploit details. Include the affected commit, reproduction, impact, and any relevant deployment assumptions. Do not access or alter data you do not own.

## Security requirements

- Passwords are bcrypt hashes; session cookies are opaque, HttpOnly, Secure in production, and stored as hashes in the database.
- All private project and asset routes perform server-side membership checks.
- Filenames never determine storage paths. Uploads are size-limited, probe-validated and processed in isolated temporary directories.
- Storage credentials are server-only. S3 assets use signed URLs; local assets stream only after authorization.
- Demucs/FFmpeg work occurs in a separate worker process. Its temporary input/output directories are deleted after terminal job state.
- A future public release requires CSRF strategy, rate limiting, account verification/reset/deletion, security headers, malware policy, moderation/reporting path, and cross-user authorization tests.
