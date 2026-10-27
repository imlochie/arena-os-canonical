---
name: Migration verification
description: Non-obvious checks for converting server-rendered Arena views to the Replit web runtime.
---

When moving a server-rendered page to client-side fetching, audit every value its JSX references, including derived labels and condition flags. A successful build and correct database response do not prove the view renders.

**Why:** Server-rendered pages can use derived values that a JSON response does not automatically include; builds and homepage checks cannot detect missing detail-page data.

**How to apply:** Exercise direct navigation to detail pages with real created records, including both pre-vote and post-vote states. Do not expose fields that were previously available only in server memory: blind battle identity must remain hidden in network payloads before voting.

Retain the distinction between successful Replit browser verification and successful Windows desktop/runtime verification.

**Why:** The user reports the Windows app has been unusable; a running web preview cannot establish that an installer, native dependencies, or local model execution works.

**How to apply:** State which environment and execution engine were actually tested. Never present the deterministic local fallback as proof that a local LLM or native desktop feature works.
