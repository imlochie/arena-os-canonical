# Contributing to Arena

## Project stage

Arena is rebuilding from the legacy ArenaForge Personal codebase. Before changing a legacy area, read [REBUILD.md](./REBUILD.md) to understand whether the capability is being kept, adapted, rebuilt, retired, or investigated. Do not remove a prior workflow merely because it is not in the first canonical slice.

## Contribution principles

- Prefer the smallest real vertical slice over a broad mock interface.
- Preserve human approval and explain automation boundaries.
- Never represent a deterministic template, seed record, mock response, or unavailable provider as real AI work.
- Preserve provenance and scope whenever creating project knowledge.
- Treat privacy and authorization as backend behavior, not UI labels.
- Make local/cloud execution visible and prevent silent cloud fallback.
- Design accessibly: semantic elements, keyboard flow, focus states, contrast, and reduced-motion support.

## Setup

Follow [DEVELOPMENT.md](./DEVELOPMENT.md). The current database setup is legacy-only and not a production migration baseline.

## Proposed workflow

1. Open or select an issue describing the user outcome, authorization/privacy implications, data-model impact, and acceptance tests.
2. Identify the relevant canonical module and the corresponding legacy entry in `REBUILD.md`.
3. Keep the change focused. Include migration(s), validation, authorization, tests, and documentation together when the behavior needs them.
4. Verify the appropriate test layers: unit, integration, API/database, authorization, provider (`MOCK`/`LOCAL`/`REAL_PROVIDER` as applicable), and browser E2E for user flows.
5. Run formatting/lint/typecheck/build once those scripts are green; document any known environmental limitation honestly.
6. Request review with a concise summary, tests run, migration/deployment notes, and screenshots only for real implemented states.

## Pull request checklist

- [ ] Existing Arena concept is mapped or intentionally retired in `REBUILD.md`/`MIGRATION.md`.
- [ ] API inputs are validated and resource access is authorized server-side.
- [ ] New persistent relationships use a migration, constraints, and indexes where required.
- [ ] Long-running work uses a durable, cancellable/idempotent job path.
- [ ] Provider/model/environment metadata is visible where the user needs it.
- [ ] No fake data, fake counter, simulated job state, or silent fallback was introduced.
- [ ] New user-visible strings are centralized enough for future localization.
- [ ] Accessibility has been considered and tested for keyboard/focus/error states.
- [ ] Tests and docs are updated.

## Commit and review scope

Use clear, imperative commit messages. Avoid incidental generated artifacts, lockfile churn unrelated to a dependency change, credential files, user exports, or database dumps. Keep code reviewable: separate dependency upgrades, migrations, API changes, and visual redesigns when practical.

## Demo content

Seed/demo data must be explicitly labelled demo content, opt-in, removable, and excluded from ordinary production statistics. It may demonstrate the core loop, but it must not simulate provider work or production activity.
