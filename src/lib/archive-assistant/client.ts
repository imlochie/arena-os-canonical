/**
 * The server-side Archive Assistant read-only client.
 *
 * Direction of the seam (see docs/archive-assistant-integration.md):
 *
 *   Arena ── server-to-server authenticated GETs ──▶ Archive Assistant API
 *        ── bounded, contract-validated facts ─────▶ Arena reasoning
 *
 * This client is the ONLY Archive Assistant seam Arena has, and it is
 * read-only by construction:
 *
 *   - It exposes exactly six GET operations (see archiveReadOnlyOperations).
 *   - It never issues POST/PUT/PATCH/DELETE. Approval, rejection, reopen,
 *     execution, rename, move, download, and sync are Archive Assistant
 *     control-plane operations and are out of scope here — tests assert no
 *     such capability exists on this module.
 *   - It never touches Archive Assistant's database, provider credentials,
 *     filesystem paths, or raw provider payloads.
 *   - It never emits the test-only `x-test-owner-id` header. Production auth
 *     is bearer forwarding; local development uses a server-configured owner
 *     constant. Client-provided owner ids are not part of the contract.
 *
 * The browser never calls Archive Assistant directly: Arena's Next.js API
 * routes create a request-scoped client and call it server-to-server.
 */

import {
  ArchiveAssistantApiError,
  ArchiveAssistantAuthRequiredError,
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  ArchiveAssistantTimeoutError,
  ArchiveAssistantUpstreamAuthError,
} from "./errors";
import type { ArchiveAssistantConfig } from "./config";
import { archiveReadOnlyOperations } from "./generated/contract";
import type {
  ProviderRefreshHistory,
  ProviderRefreshState,
  ReconciliationSummary,
} from "./generated/types";
import type { ArchiveOverview, ArchiveWorkload, FindingLineage } from "./types";
import { validateContract } from "./validate";
import type {
  ArchiveContextClient,
  ArchiveProvider,
  ProviderRefreshHistoryOptions,
} from "./types";

// Server-only guard: importing this module into a browser bundle throws.
if (typeof window !== "undefined") {
  throw new Error(
    "archive-assistant/client is server-only. The browser must use Arena's /api/archive/* routes.",
  );
}

/** Auth material for ONE request. Bearer mode forwards the authenticated
 *  Arena user's token verbatim; Archive Assistant validates it (Clerk) and
 *  derives the owner. Local mode attaches a server-configured owner constant
 *  (development only). */
export type ArchiveAssistantAuth =
  | { mode: "bearer"; token: string }
  | { mode: "local"; ownerId: string };

/** Extract the bearer token from an incoming Arena request, honouring the
 *  "no token, no archive access" rule. */
export function resolveRequestAuth(
  req: Request,
  config: ArchiveAssistantConfig,
): ArchiveAssistantAuth {
  if (config.authMode === "local") {
    // The owner id is a server-configured constant from
    // ARCHIVE_ASSISTANT_OWNER_ID — never read from the request.
    return { mode: "local", ownerId: config.ownerId ?? "" };
  }
  const header = req.headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) {
    throw new ArchiveAssistantAuthRequiredError();
  }
  return { mode: "bearer", token };
}

type OperationName = keyof typeof archiveReadOnlyOperations;

/** Bounded history: Arena never asks for more than this per request. */
const HISTORY_MAX_PAGE_SIZE = 25;
const HISTORY_DEFAULT_PAGE_SIZE = 10;

export type ArchiveAssistantClientOptions = {
  fetchImpl?: typeof fetch;
};

export function createArchiveAssistantClient(
  config: ArchiveAssistantConfig,
  auth: ArchiveAssistantAuth,
  options: ArchiveAssistantClientOptions = {},
): ArchiveContextClient {
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

  async function call(
    operation: OperationName,
    pathParams: Record<string, string>,
    query: Record<string, string>,
  ): Promise<unknown> {
    const op = archiveReadOnlyOperations[operation] as {
      method: string;
      path: string;
      response: string;
    };
    if (op.method !== "GET") {
      // Defensive invariant: this module cannot mutate even if the upstream
      // spec is later regenerated with a broader subset by mistake.
      throw new Error(`archive-assistant client is read-only; refusing ${op.method} ${op.path}`);
    }

    let path = op.path;
    for (const [key, value] of Object.entries(pathParams)) {
      path = path.replace(`{${key}}`, encodeURIComponent(value));
    }
    const url = new URL(config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

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
        throw new ArchiveAssistantTimeoutError(operation, config.timeoutMs);
      }
      throw new ArchiveAssistantApiError(0, operation);
    }

    if (res.status === 404) throw new ArchiveAssistantNotFoundError(operation);
    if (res.status === 401 || res.status === 403) {
      throw new ArchiveAssistantUpstreamAuthError(res.status, operation);
    }
    if (!res.ok) throw new ArchiveAssistantApiError(res.status, operation);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ArchiveAssistantContractError(op.response, "$", "response is not valid JSON");
    }
    validateContract(op.response, body);
    return body;
  }

  const client: ArchiveContextClient = {
    getOverview(): Promise<ArchiveOverview> {
      return call("getAssistantOverview", {}, {}) as Promise<ArchiveOverview>;
    },

    getWorkload(): Promise<ArchiveWorkload> {
      return call("getAssistantWorkload", {}, {}) as Promise<ArchiveWorkload>;
    },

    async getReconciliationSummary(): Promise<ReconciliationSummary> {
      // Bounded: a single-row page is enough — the summary aggregates all
      // owner-scoped results, and Arena never pages through raw rows.
      const report = (await call("getArchiveReconciliation", {}, { page: "1", pageSize: "1" })) as {
        summary: ReconciliationSummary;
      };
      return report.summary;
    },

    getFindingLineage(reviewItemId: number): Promise<FindingLineage> {
      if (!Number.isInteger(reviewItemId) || reviewItemId < 1) {
        return Promise.reject(
          new ArchiveAssistantContractError(
            "ReconciliationFindingLineage",
            "reviewItemId",
            "must be a positive integer",
          ),
        );
      }
      return call(
        "getReconciliationFindingLineage",
        { reviewItemId: String(reviewItemId) },
        {},
      ) as Promise<FindingLineage>;
    },

    getProviderRefreshState(provider: ArchiveProvider): Promise<ProviderRefreshState> {
      return call("getProviderRefreshState", {}, { provider }) as Promise<ProviderRefreshState>;
    },

    getProviderRefreshHistory(
      provider: ArchiveProvider,
      options: ProviderRefreshHistoryOptions = {},
    ): Promise<ProviderRefreshHistory> {
      const page = Math.max(1, Math.floor(options.page ?? 1));
      const pageSize = Math.min(
        HISTORY_MAX_PAGE_SIZE,
        Math.max(1, Math.floor(options.pageSize ?? HISTORY_DEFAULT_PAGE_SIZE)),
      );
      return call(
        "listProviderRefreshHistory",
        {},
        { provider, page: String(page), pageSize: String(pageSize) },
      ) as Promise<ProviderRefreshHistory>;
    },
  };

  // Frozen: the read-only capability surface cannot be extended at runtime.
  return Object.freeze(client);
}
