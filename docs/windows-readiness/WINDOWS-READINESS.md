# Arena OS — Windows readiness and integration record

**Branch:** `arena/windows-ready-integration-2026-10-22`
**Base:** `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` (PR #25, verified unchanged)
**Workflow:** `.github/workflows/windows-acceptance.yml` on `windows-latest`
**Ledger and manifest:** [`INTEGRATION-LEDGER.md`](./INTEGRATION-LEDGER.md), [`convergence-manifest.json`](./convergence-manifest.json)

This record separates four kinds of evidence, because they are not
interchangeable:

1. **Linux evidence** (this checkout): typecheck, 168/168 desktop tests, the
   full source suite inherited from the previous integration session.
2. **Windows evidence** (GitHub-hosted `windows-latest` runner): clean install,
   desktop contract tests, staging, installer build, installed-app acceptance.
3. **Inherited evidence** (earlier sessions on `13638fe`): Arcade, Spaces and
   Waveyard product workflows. Re-listed, not re-claimed.
4. **Not run**: anything that needs a real Windows desktop, audio hardware,
   GPU, or a human listener. Listed in §7, never scored as a pass.

---

*(Sections 1-9 are completed in the final revision of this document; the CI
results below are transcribed from the exact run IDs cited, not summarised.)*
