# Device and Node Recovery

Recovery is an authority-preserving operation, never a bypass.

- **Lost phone:** revoke the device; all bound authenticated sessions cease authorizing. Enroll a replacement only through a surviving high-assurance owner credential. Revoked grants are not copied.
- **Compromised phone/session:** revoke the device and session records, review security events, then issue narrowly scoped grants to a newly enrolled device.
- **Lost/compromised node:** revoke its active node key. Pending node requests are invalidated. Enroll a replacement key through an already authorized owner device.
- **Routine node-key rotation:** enroll the replacement as a higher version. The previous key enters `rotating` for a five-minute overlap so already-issued responses can finish, then is no longer eligible.
- **Database restoration:** authenticated sessions, nonce history, grants, and key revocation records must be restored with the database. If freshness cannot be established, revoke sessions and require WebAuthn again.
- **Artifact key loss:** ciphertext is intentionally unrecoverable without the configured master key. Back up the key separately from blobs and the database. There is no hidden recovery key.

Recovery does not reactivate revoked capability grants and does not expose a network enrollment endpoint. A production recovery ceremony and external key-management integration remain required before Arena is relied on as the sole archive.
