/**
 * Server-side client for the seventh read — the Gate-6 evidence seam.
 *
 * Direction of the seam (docs/archive-assistant-integration.md §Gate 6):
 *
 *   Arena ── server-to-server authenticated GET ──▶ Archive Assistant API
 *        ── contract-validated evidence context ──▶ Arena reasoning context
 *
 * Read-only and parameter-free by construction:
 *
 *   - It exposes exactly one GET operation, taken from the GENERATED
 *     operation table (never typed by hand): getArchivePersonalisationContext.
 *   - It never issues POST/PUT/PATCH/DELETE.
 *   - It carries NO query parameters and NO request body: the endpoint is
 *     owner-scoped upstream from the forwarded credentials. Owner identity
 *     can therefore never come from request input — bearer mode forwards the
 *     authenticated Arena user's token verbatim; local mode attaches a
 *     server-configured owner constant (development only). The test-only
 *     `x-test-owner-id` header is never emitted.
 *   - It never touches Archive Assistant's database, provider credentials,
 *     filesystem paths, or raw provider payloads.
 *
 * The browser never calls Archive Assistant directly; this module is
 * server-only.
 */

import {
  ArchiveAssistantApiError,
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  ArchiveAssistantTimeoutError,
  ArchiveAssistantUpstreamAuthError,
} from "../archive-assistant/errors";
import type { ArchiveAssistantConfig } from "../archive-assistant/config";
import type { ArchiveAssistantAuth } from "../archive-assistant/client";
import { personalisationOperations } from "./generated/contract";
import type { PersonalisationContext } from "./generated/types";
import type { PersonalisationEvidenceClient } from "./types";
import { validatePersonalisationContract } from "./validate";

// Server-only guard: importing this module into a browser bundle throws.
if (typeof window !== "undefined") {
  throw new Error(
    "personalisation/client is server-only. The browser must never reach Archive Assistant directly.",
  );
}

export type PersonalisationClientOptions = {
  fetchImpl?: typeof fetch;
};

export function createPersonalisationEvidenceClient(
  config: ArchiveAssistantConfig,
  auth: ArchiveAssistantAuth,
  options: PersonalisationClientOptions = {},
): PersonalisationEvidenceClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  function authHeaders(): Record<string, string> {
    // The test-only `x-test-owner-id` header is intentionally absent in
    // every mode — tests scan for it. Local mode's owner header is a
    // distinct, server-configured development constant.
    if (auth.mode === "local") {
      return { "x-archive-assistant-owner-id": auth.ownerId };
    }
    return { authorization: `Bearer ${auth.token}` };
  }

  async function getPersonalisationContext(): Promise<PersonalisationContext> {
    const op = (
      personalisationOperations as Record<string, { method: string; path: string; response: string }>
    ).getArchivePersonalisationContext;
    if (op.method !== "GET") {
      // Defensive invariant: this module cannot mutate even if the upstream
      // spec is later regenerated with a broader subset by mistake.
      throw new Error(`personalisation client is read-only; refusing ${op.method} ${op.path}`);
    }

    const url = new URL(config.baseUrl + op.path);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders() },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ArchiveAssistantTimeoutError("getArchivePersonalisationContext", config.timeoutMs);
      }
      throw new ArchiveAssistantApiError(0, "getArchivePersonalisationContext");
    }

    if (res.status === 404) throw new ArchiveAssistantNotFoundError("getArchivePersonalisationContext");
    if (res.status === 401 || res.status === 403) {
      throw new ArchiveAssistantUpstreamAuthError(res.status, "getArchivePersonalisationContext");
    }
    if (!res.ok) throw new ArchiveAssistantApiError(res.status, "getArchivePersonalisationContext");

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ArchiveAssistantContractError(op.response, "$", "response is not valid JSON");
    }
    validatePersonalisationContract(op.response, body);
    return body as PersonalisationContext;
  }

  // Frozen: the read-only capability surface cannot be extended at runtime.
  return Object.freeze({ getPersonalisationContext });
}
