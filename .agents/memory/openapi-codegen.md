---
name: OpenAPI generator naming
description: Named request schemas avoid duplicate generated body exports in this workspace.
---
Prefer named component schemas for new structured OpenAPI request bodies.

**Why:** Inline object bodies produced conflicting body-type exports in the Zod
barrel. Generation itself succeeded; the generated-library TypeScript build exposed
the collision. References to named input schemas resolved it.

**How to apply:** Generate from the spec rather than editing generated files, and
check the generated libraries, not just frontend/API consumers.
