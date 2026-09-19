/**
 * Gate-6 acceptance suite: the Arena personalisation-evidence adapter.
 *
 * These tests prove the boundary, not intelligence. The adapter receives
 * authoritative evidence over the seventh read and preserves it; anything
 * that would make the archive "smarter" is Gate 7 and must not exist here.
 *
 * Tests 1–8 are the owner-specified acceptance surface (2026-09-19), named
 * and numbered to match:
 *
 *   1. server-to-server only
 *   2. owner scoping cannot come from request input
 *   3. runtime schema validation occurs at ingress
 *   4. all eight arrays survive normalization
 *   5. the full evidence envelope survives (signalId, epistemicStatus,
 *      scopeIdentity, coverage, provenance — including batchIds — derivedAt)
 *   6. incomplete / non-authoritative evidence is not converted into absence
 *   7. Gen-1 presentation semantics do not reappear
 *   8. epistemic status is never upgraded; empty stays empty
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getArchiveAssistantConfig } from "../archive-assistant/config";
import {
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  ArchiveAssistantUpstreamAuthError,
} from "../archive-assistant/errors";
import { createPersonalisationEvidenceClient } from "./client";
import { fetchPersonalisationEvidence, normalizePersonalisationContext } from "./context";
import type { PersonalisationContext } from "./generated/types";
import {
  personalisationContractMeta,
  personalisationOperations,
  personalisationSchemas,
  validatePersonalisationContract,
} from "./validate";
import { canonicalWire, emptyWire, makePersonalisationFetchStub, minimalWire } from "./fixtures";

const BASE_ENV = {
  ARCHIVE_ASSISTANT_API_URL: "https://archive-assistant.example.com/api",
};

const EIGHT_COLLECTIONS = [
  "facts",
  "observedSignals",
  "temporalSignals",
  "collectionFacts",
  "interpretations",
  "uncertainties",
  "explicitPreferences",
  "constraints",
] as const;

/** Adapter-code identifiers from the retired Gen-1 presentation layer that
 *  must never reappear on this seam. */
const GEN1_IDENTIFIERS = [
  "personalAffinity",
  "personalRelevance",
  "suggestedForYou",
  "personalizedBriefing",
  "watchedMinutes",
  "viewCount",
  "lastViewedAt",
];

function asWire(payload: unknown): PersonalisationContext {
  return payload as unknown as PersonalisationContext;
}

function makeClient(
  auth: { mode: "bearer"; token: string } | { mode: "local"; ownerId: string },
  routes: Record<string, unknown> = {},
) {
  const env =
    auth.mode === "local"
      ? { ...BASE_ENV, ARCHIVE_ASSISTANT_AUTH_MODE: "local", ARCHIVE_ASSISTANT_OWNER_ID: auth.ownerId }
      : BASE_ENV;
  const config = getArchiveAssistantConfig(env);
  const { stub, calls } = makePersonalisationFetchStub(routes);
  const client = createPersonalisationEvidenceClient(config, auth, { fetchImpl: stub });
  return { client, calls };
}

function readModuleSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

/* ---------------------- contract sanity (pre-flight) --------------------- */

test("contract sanity: the generated snapshot exposes exactly the seventh read, GET-only", () => {
  assert.deepEqual(Object.keys(personalisationOperations), ["getArchivePersonalisationContext"]);
  const op = personalisationOperations.getArchivePersonalisationContext as {
    method: string;
    path: string;
    response: string;
  };
  assert.equal(op.method, "GET");
  assert.equal(op.path, "/assistant/personalisation-context");
  assert.equal(op.response, "PersonalisationContext");

  // The transcript of authority: the snapshot records the owner-verified ref.
  assert.match(personalisationContractMeta.sourceRef, /8e54a283c392c53f64099a903b293de220e565ce/);
});

test("contract sanity: PersonalisationContext requires domain plus all eight collections", () => {
  const schema = (personalisationSchemas as Record<string, { required?: string[] }>)
    .PersonalisationContext;
  assert.ok(schema, "PersonalisationContext must be in the generated snapshot");
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    ["domain", ...EIGHT_COLLECTIONS].sort(),
  );
});

test("contract sanity: temporal window is producer-declared, closed, and required", () => {
  // Upstream 3180bf9 made TemporalSignalValue.window REQUIRED and typed it
  // as a closed TemporalWindow {startsAt, endsAt}. The snapshot must carry
  // that authority verbatim — the meaning crossed the contract.
  const schemas = personalisationSchemas as Record<string, Record<string, unknown>>;
  const tw = schemas.TemporalWindow;
  assert.ok(tw, "TemporalWindow must be in the generated snapshot");
  assert.deepEqual(tw.required, ["startsAt", "endsAt"]);
  assert.equal(tw.additionalProperties, false);
  const tsv = schemas.TemporalSignalValue;
  assert.deepEqual(tsv.required, ["window"]); // previousWindow optional again since upstream 8e54a28 (previous observation now its own row)
  const pts = schemas.PersonalisationTemporalSignal as {
    allOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
  };
  const overlay = pts.allOf?.find((part) => part.required?.includes("value"));
  assert.ok(overlay, "temporal signals must require their typed value ($ref TemporalSignalValue)");
  assert.ok(JSON.stringify(overlay?.properties?.value ?? null).includes("TemporalSignalValue"));
});

test("contract sanity: every fixture is valid against the generated snapshot", () => {
  for (const payload of [canonicalWire(), emptyWire(), minimalWire()]) {
    validatePersonalisationContract("PersonalisationContext", payload);
  }
});

/* --------------------- 1. server-to-server only -------------------------- */

test("gate-6 #1: the seam is server-to-server only — one GET, no browser path, no mutations", async () => {
  const { client, calls } = makeClient({ mode: "bearer", token: "token-a" });

  // One method, named by the contract, and nothing else on the surface.
  assert.deepEqual(Object.keys(client), ["getPersonalisationContext"]);

  await client.getPersonalisationContext();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  const url = new URL(calls[0].url);
  assert.ok(url.pathname.endsWith("/assistant/personalisation-context"));
  assert.equal(url.search, "", "the seventh read takes no query input");

  // Static guarantees: the module guards against browser bundles, never
  // issues a mutating method, and never builds a request body.
  const source = readModuleSource("client.ts");
  assert.match(source, /typeof window !== "undefined"/);
  assert.ok(
    !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(source),
    "client.ts must contain no mutating HTTP method",
  );
  assert.ok(!/NEXT_PUBLIC_/.test(source + readModuleSource("context.ts")));
  assert.ok(!/process\.env\b/.test(readModuleSource("client.ts")),
    "client.ts reads configuration only via the injected bridge config");
});

/* ------------- 2. owner scoping cannot come from request input ----------- */

test("gate-6 #2: owner scoping rides forwarded credentials, never request input", async () => {
  // Bearer mode: only the user's forwarded token crosses; no owner header,
  // no owner query, and never the test-only header.
  const bearer = makeClient({ mode: "bearer", token: "token-b" });
  await bearer.client.getPersonalisationContext();
  const bearerHeaders = Object.keys(bearer.calls[0].headers).sort();
  assert.deepEqual(bearerHeaders, ["accept", "authorization"]);
  assert.equal(bearer.calls[0].headers.authorization, "Bearer token-b");
  assert.ok(!("x-test-owner-id" in bearer.calls[0].headers));
  assert.ok(!("x-archive-assistant-owner-id" in bearer.calls[0].headers));
  assert.equal(new URL(bearer.calls[0].url).search, "");

  // Local development mode: the owner attached is the SERVER-configured
  // constant — the same value the process was configured with — and still
  // never the test-only header.
  const local = makeClient({ mode: "local", ownerId: "__local__" });
  await local.client.getPersonalisationContext();
  const localHeaders = Object.keys(local.calls[0].headers).sort();
  assert.deepEqual(localHeaders, ["accept", "x-archive-assistant-owner-id"]);
  assert.equal(local.calls[0].headers["x-archive-assistant-owner-id"], "__local__");
  assert.ok(!("x-test-owner-id" in local.calls[0].headers));

  // The test-only escape hatch is not woven into client code as an
  // emittable property, in any mode (comments documenting the prohibition
  // are expected and ignored).
  const source = readModuleSource("client.ts");
  assert.ok(
    !/["']x-test-owner-id["']\s*:/.test(source),
    "client.ts must never emit the x-test-owner-id header",
  );
});

/* ------------- 3. runtime schema validation occurs at ingress ------------ */

test("gate-6 #3: every response is validated against the generated snapshot at ingress", async () => {
  // Valid payload crosses.
  const ok = makeClient({ mode: "bearer", token: "token-c" });
  const body = await ok.client.getPersonalisationContext();
  assert.ok(Array.isArray((body as { facts: unknown[] }).facts));

  // Missing a required collection → contract violation before normalization.
  const missing = canonicalWire() as Record<string, unknown>;
  delete missing.uncertainties;
  const brokenMissing = makeClient({ mode: "bearer", token: "token-c" }, {
    "/assistant/personalisation-context": missing,
  });
  await assert.rejects(brokenMissing.client.getPersonalisationContext(), (error: unknown) => {
    assert.ok(error instanceof ArchiveAssistantContractError);
    assert.equal(error.kind, "contract_violation");
    assert.match(error.message, /missing required property "uncertainties"/);
    return true;
  });

  // Epistemic status outside the contract enum → violation.
  const badEnum = canonicalWire() as { facts: Array<Record<string, unknown>> };
  badEnum.facts[0].epistemicStatus = "confirmed";
  const brokenEnum = makeClient({ mode: "bearer", token: "token-c" }, {
    "/assistant/personalisation-context": badEnum,
  });
  await assert.rejects(brokenEnum.client.getPersonalisationContext(), /expected one of/);

  // Mistyped lineage (batchIds as a bare string) → violation at that path.
  const badLineage = canonicalWire() as unknown as {
    observedSignals: Array<{ provenance: Record<string, unknown> }>;
  };
  badLineage.observedSignals[0].provenance.batchIds = "ing-2026-09-18-01";
  const brokenLineage = makeClient({ mode: "bearer", token: "token-c" }, {
    "/assistant/personalisation-context": badLineage,
  });
  await assert.rejects(brokenLineage.client.getPersonalisationContext(), (error: unknown) => {
    assert.ok(error instanceof ArchiveAssistantContractError);
    assert.match(error.schemaPath, /observedSignals\[0\]\.provenance\.batchIds/);
    return true;
  });

  // A null body: present-but-untyped — a contract violation, never a
  // silent "empty context".
  const nullBody = makeClient({ mode: "bearer", token: "token-c" }, {
    "/assistant/personalisation-context": null,
  });
  nullBody.calls.length = 0;
  await assert.rejects(nullBody.client.getPersonalisationContext(), ArchiveAssistantContractError);

  // Non-JSON body → violation; upstream auth rejection and 404 map onto the
  // bridge taxonomy without synthesizing owner-scoped data.
  const config = getArchiveAssistantConfig(BASE_ENV);
  const invalidJsonClient = createPersonalisationEvidenceClient(
    config,
    { mode: "bearer", token: "token-c" },
    {
      fetchImpl: (() =>
        Promise.resolve(
          new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
        )) as unknown as typeof fetch,
    },
  );
  await assert.rejects(invalidJsonClient.getPersonalisationContext(), ArchiveAssistantContractError);

  const unauthorized = createPersonalisationEvidenceClient(
    config,
    { mode: "bearer", token: "expired" },
    { fetchImpl: (() => Promise.resolve(new Response("denied", { status: 401 }))) as unknown as typeof fetch },
  );
  await assert.rejects(unauthorized.getPersonalisationContext(), ArchiveAssistantUpstreamAuthError);

  const notFound = createPersonalisationEvidenceClient(
    config,
    { mode: "bearer", token: "token-c" },
    { fetchImpl: (() => Promise.resolve(new Response("gone", { status: 404 }))) as unknown as typeof fetch },
  );
  await assert.rejects(notFound.getPersonalisationContext(), ArchiveAssistantNotFoundError);
});

/* -------------- 4. all eight arrays survive normalization ---------------- */

test("gate-6 #4: domain plus all eight collections survive normalization verbatim", () => {
  const wire = asWire(canonicalWire());
  const { transport, evidence } = normalizePersonalisationContext(wire);

  assert.deepEqual(
    Object.keys(evidence).sort(),
    ["domain", ...EIGHT_COLLECTIONS].sort(),
    "the evidence body carries exactly domain + the eight collections — nothing added, nothing dropped",
  );
  for (const key of EIGHT_COLLECTIONS) {
    assert.deepEqual(evidence[key], wire[key], `${key} must cross verbatim`);
  }
  assert.equal(evidence.domain, wire.domain);

  // Arena may label the source of evidence — as transport metadata,
  // wrapping the evidence, never inside it.
  assert.equal(transport.endpoint, "GET /assistant/personalisation-context");
  assert.match(transport.contractRef, /8e54a283c392c53f64099a903b293de220e565ce/);
  assert.ok(Number.isFinite(Date.parse(transport.receivedAt)));

  // The honest-empty context also survives: every collection present.
  const empty = normalizePersonalisationContext(asWire(emptyWire())).evidence;
  for (const key of EIGHT_COLLECTIONS) {
    assert.ok(key in empty, `${key} must survive even when empty`);
    assert.deepEqual(empty[key], []);
  }

  // The evidence body is frozen — evidence is not mutable Arena state.
  assert.ok(Object.isFrozen(evidence));
  const rich = normalizePersonalisationContext(asWire(canonicalWire())).evidence;
  assert.ok(Object.isFrozen(rich.observedSignals));
  assert.ok(Object.isFrozen(rich.observedSignals[0]));
  assert.ok(Object.isFrozen(rich.observedSignals[0].provenance));
});

/* ------------- 5. the full evidence envelope survives -------------------- */

test("gate-6 #5: signalId/epistemicStatus/scopeIdentity/coverage/provenance (batchIds)/derivedAt survive", () => {
  const wire = asWire(canonicalWire());
  const { evidence } = normalizePersonalisationContext(wire);

  for (const collection of ["observedSignals", "temporalSignals", "collectionFacts"] as const) {
    for (const [index, item] of evidence[collection].entries()) {
      const wireItem = (wire[collection] as Array<Record<string, unknown>>)[index];
      // Whole-item fidelity first — nothing in the envelope was touched.
      assert.deepEqual(item, wireItem);

      for (const envelopeKey of [
        "signalId",
        "signalType",
        "subjectIdentity",
        "value",
        "epistemicStatus",
        "scopeIdentity",
        "coverage",
        "provenance",
        "derivedAt",
      ]) {
        assert.ok(envelopeKey in item, `${collection}[${index}] must keep ${envelopeKey}`);
      }

      // The provider/event/batch lineage crosses under its contract names:
      // batchIds is batchIds — no Arena-side ingestionBatch rename.
      const provenance = item.provenance as Record<string, unknown>;
      assert.deepEqual(provenance.derivedFrom, "watch_observation");
      assert.ok(Array.isArray(provenance.eventIds));
      assert.ok(Array.isArray(provenance.providerEventIds));
      assert.ok(Array.isArray(provenance.batchIds));
      // The regenerated contract (upstream b5ca164) adds observation-level
      // handles; they cross verbatim, and the adapter invents neither its
      // own spellings nor synthetic identities.
      assert.ok(Array.isArray(provenance.observationIds));
      assert.ok(Array.isArray(provenance.evidenceKeys));
      assert.ok(Array.isArray(provenance.ingestionBatchIds));
      assert.ok(Array.isArray(provenance.eventOccurredAt));
      assert.ok(Array.isArray(provenance.observedAt));
      assert.ok(!("observationId" in provenance));
      assert.ok(!("evidenceKey" in provenance));
      assert.ok("scopeIdentity" in provenance);
      assert.ok(!("ingestionBatch" in provenance));
      assert.ok(!("ingestionBatch" in item));
    }
  }

  // Facts carry their epistemic status and provenance verbatim too.
  for (const [index, fact] of evidence.facts.entries()) {
    assert.equal(fact.epistemicStatus, wire.facts[index].epistemicStatus);
    assert.deepEqual(fact.provenance, wire.facts[index].provenance);
  }
});

/* ----- 6. incomplete / non-authoritative evidence ≠ absence -------------- */

test("gate-6 #6: coverage-limited and unknown evidence is preserved, never flattened to absence", () => {
  const wire = asWire(canonicalWire());
  const { evidence } = normalizePersonalisationContext(wire);

  const coverageLimited = evidence.facts.find((fact) => fact.factType === "jellyfin_session_metrics");
  const unknown = evidence.facts.find((fact) => fact.factType === "watchlist_presence");
  assert.ok(coverageLimited && unknown, "fixture must carry both classes");
  assert.equal(coverageLimited.epistemicStatus, "coverage-limited");
  assert.equal(unknown.epistemicStatus, "unknown");
  // Their (honest, possibly empty) values cross as-is — not nulled out,
  // not omitted, not converted into "empty"/"absent" vocabulary.
  assert.deepEqual(coverageLimited.value, {});
  assert.deepEqual(unknown.value, {});
  assert.deepEqual(unknown.provenance, {
    derivedFrom: "provider_inventory",
    note: "no watchlist source configured",
  });

  // The uncertainty record covering that scope survives whole.
  assert.equal(evidence.uncertainties.length, 1);
  assert.equal(evidence.uncertainties[0].epistemicStatus, "coverage-limited");
  assert.match(evidence.uncertainties[0].reason ?? "", /Jellyfin/);

  // Minimal optionals: an uncertainty/interpretation carrying only its
  // required class marker must come through with NO synthesized fields.
  const minimal = normalizePersonalisationContext(asWire(minimalWire())).evidence;
  assert.deepEqual(Object.keys(minimal.uncertainties[0]).sort(), ["evidenceClass"]);
  assert.deepEqual(Object.keys(minimal.interpretations[0]).sort(), ["evidenceClass"]);

  // Absence stays absence: with no interpretations on the wire, the adapter
  // manufactures none from facts, signals, or uncertainties.
  const bare = asWire({ ...emptyWire(), uncertainties: minimalWire().uncertainties });
  const bareEvidence = normalizePersonalisationContext(bare).evidence;
  assert.deepEqual(bareEvidence.interpretations, []);
  assert.deepEqual(bareEvidence.facts, []);
});

/* ---------- contract-refresh: real-surface null + handle fidelity ---------- */

test("validator: untyped unknown fact value accepts null (real surface emits it); typed null still refused", () => {
  // The REAL upstream surface at b5ca164 emits an unknown fact with
  // `value: null` (hoursWatched). The spec's `value: {}` is untyped →
  // `unknown`; the runtime validator must not be stricter than the
  // contract it enforces. Found by feeding producer-authored output to
  // the validator; the repair is in the shared machinery, not the
  // documents.
  const wireWithNull = {
    ...canonicalWire(),
    facts: [
      ...canonicalWire().facts.map((f) => ({ ...f })),
      { evidenceClass: "fact", factType: "hoursWatched", value: null, epistemicStatus: "unknown", provenance: { source: "Analytics", observedAt: ["2026-09-19T10:00:00.000Z"], eventIds: [1] } },
    ],
  };
  assert.doesNotThrow(() => validatePersonalisationContract("PersonalisationContext", wireWithNull));
  // Typed fields keep their null gate (preserved strictness):
  const typedNull = { ...canonicalWire(), facts: [{ ...canonicalWire().facts[0], epistemicStatus: null }] };
  assert.throws(() => validatePersonalisationContract("PersonalisationContext", typedNull));
});

test("gate-6 #7: no Gen-1 presentation identifier exists on this seam", () => {
  // The generated contract (the authority itself) is free of them.
  const snapshotJson = JSON.stringify(personalisationSchemas) + JSON.stringify(personalisationOperations);
  for (const identifier of GEN1_IDENTIFIERS) {
    assert.ok(!snapshotJson.includes(identifier), `generated snapshot must not mention ${identifier}`);
  }

  // The adapter module sources are free of them.
  for (const name of ["client.ts", "context.ts", "types.ts", "validate.ts"]) {
    const source = readModuleSource(name);
    for (const identifier of GEN1_IDENTIFIERS) {
      assert.ok(!source.includes(identifier), `${name} must not mention ${identifier}`);
    }
  }

  // And nothing the normalizer emits can smuggle them in.
  const roundTripped = JSON.parse(
    JSON.stringify(normalizePersonalisationContext(asWire(canonicalWire())).evidence),
  ) as Record<string, unknown>;
  for (const identifier of GEN1_IDENTIFIERS) {
    assert.ok(!JSON.stringify(roundTripped).includes(identifier));
  }
});

/* --------------- 8. epistemic status is never upgraded ------------------- */

test("gate-6 #8: derived stays derived; empty stays empty; nothing is manufactured", async () => {
  const collectStatuses = (body: Record<string, Array<Record<string, unknown>>>) => {
    const statuses: string[] = [];
    for (const key of [
      "facts",
      "observedSignals",
      "temporalSignals",
      "collectionFacts",
      "interpretations",
      "uncertainties",
    ] as const) {
      for (const item of body[key] ?? []) {
        if (typeof item.epistemicStatus === "string") statuses.push(`${key}:${item.epistemicStatus}`);
      }
    }
    return statuses.sort();
  };

  const wire = asWire(canonicalWire());
  const { evidence } = normalizePersonalisationContext(wire);

  // The epistemic-status multiset is identical before and after the seam.
  assert.deepEqual(
    collectStatuses(evidence as unknown as Record<string, Array<Record<string, unknown>>>),
    collectStatuses(wire as unknown as Record<string, Array<Record<string, unknown>>>),
  );

  // Full round-trip fidelity of the evidence projection: if anything had
  // been upgraded, rounded, re-labeled, or synthesized, this equality
  // would break.
  const projection = (body: Record<string, unknown>) =>
    Object.fromEntries(["domain", ...EIGHT_COLLECTIONS].map((key) => [key, body[key]]));
  assert.deepEqual(
    JSON.parse(JSON.stringify(evidence)),
    projection(wire as unknown as Record<string, unknown>),
  );

  // Empty collections on the wire stay empty and present — no manufactured
  // uncertainty, interpretation, preference, or confidence because the
  // schema technically allows them.
  const sparse = asWire({
    ...canonicalWire(),
    uncertainties: [],
    explicitPreferences: [],
    interpretations: [],
    observedSignals: [],
  });
  validatePersonalisationContract("PersonalisationContext", sparse);
  const sparseEvidence = normalizePersonalisationContext(sparse).evidence;
  assert.deepEqual(sparseEvidence.uncertainties, []);
  assert.deepEqual(sparseEvidence.explicitPreferences, []);
  assert.deepEqual(sparseEvidence.interpretations, []);
  assert.deepEqual(sparseEvidence.observedSignals, []);
  assert.ok(!("confidence" in sparseEvidence));
  assert.ok(!("score" in sparseEvidence));

  // The receive pipeline as a whole (fetch → validate → normalize) yields
  // the same preserved body: transport adds labeling, never semantics.
  const { client } = makeClient({ mode: "bearer", token: "token-d" });
  const reception = await fetchPersonalisationEvidence(client);
  assert.deepEqual(
    collectStatuses(reception.evidence as unknown as Record<string, Array<Record<string, unknown>>>),
    collectStatuses(asWire(canonicalWire()) as unknown as Record<string, Array<Record<string, unknown>>>),
  );
});
