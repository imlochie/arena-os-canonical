# LUMA ↔ Arena media integration boundary

This document defines an optional integration seam. It is intentionally boring:
there is no authentication, API client, database code, sync implementation, or
Arena import in LUMA's creative core.

## Ownership

**LUMA owns:** capture, import, image analysis, cameras, looks, recipes, editing,
rendering, exports, and processing lineage.

**Arena owns:** identity, authentication, sessions, commitments, context,
evidence records, provenance relationships, institutional metadata, permissions,
and synchronization.

LUMA remains fully functional offline and without an Arena account.

## Contract

`src/integration/ArenaMediaBridge.ts` defines the optional host boundary:

```ts
interface ArenaMediaBridge {
  createMediaRecord(input: {
    source: 'capture' | 'import';
    original: { uri: string; capturedAt?: string };
    derivative?: { uri: string; recipe: EditRecipe };
  }): Promise<{ mediaId: string }>;

  attachToContext(input: {
    mediaId: string;
    contextType: string;
    contextId: string;
  }): Promise<void>;
}
```

The `uri` is a host-managed location, not an asset identity. `mediaId` is the
Arena-side identity returned by the integration host. This leaves room for local
file URLs, content-addressed objects, or remote media without coupling LUMA to
any one storage system.

## Provenance and layers of truth

A LUMA artifact can be represented as:

```text
original capture/import
  ├── preserved source
  └── derivative export
        └── recipe + processing lineage
              ↓
          optional Arena media record
              ├── provenance
              ├── context/evidence attachment
              └── institutional interpretation
```

Arena records what happened around a LUMA artifact. It does **not** determine
what the artifact means. A LUMA look, adaptive analysis result, or edit is an
interpretation/derivative and must not silently become an institutional fact.
The original remains distinguishable from derivatives and later Arena context.

## Adapter rules

- The adapter is injected at an application boundary, never into the engine.
- The processing engine must not import this module.
- Failure or absence of the adapter must not block capture, editing, or export.
- Sync and attachment should be explicit user/application actions, not hidden
  side effects of rendering or saving locally.
- Future LUMA Web, Windows, and iPhone hosts may provide different adapters
  while preserving this contract.

The default `noopArenaMediaBridge` fails only if called, making accidental
integration attempts visible while keeping standalone LUMA local-first.
