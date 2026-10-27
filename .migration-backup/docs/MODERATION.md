# Publication and Moderation

Projects begin private. Owners choose `private`, `unlisted`, or `public` only after supplying licensing and rights information. Publication does not assert that a user owns uploaded material; users remain responsible for their rights.

Public projects have moderation state `active`, `hidden`, `reported`, or `removed`. Reports, moderation decisions, and restores are durable audit events. Hiding public work removes it from discovery without silently deleting owner data. Private assets are never made public by a moderation UI mistake.

## Implemented Phase 4 boundary

The implementation records all publication and moderation decisions in append-only `project_audit_events`. An authenticated reporter can submit one bounded report per currently public/unlisted project. A persisted platform moderator—not a project owner—may hide, restore, or remove public access with a reason. `hidden` and `removed` withdraw the public page, catalogue, and selected release stream without deleting owner data or private media. See [Phase 4 Publication & Discovery](PHASE_4_PUBLICATION.md) for effective-state, storage, and API details.
