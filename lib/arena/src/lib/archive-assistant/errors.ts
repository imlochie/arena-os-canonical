/**
 * Error taxonomy for the Archive Assistant read-only bridge.
 *
 * Server-only. Error messages are safe to surface to the Arena caller: they
 * never include upstream response bodies, tokens, owner ids, or filesystem
 * paths — only the failing operation, HTTP status, or schema path.
 */

export type ArchiveAssistantErrorKind =
  | "not_configured"
  | "auth_required"
  | "upstream_auth_failed"
  | "not_found"
  | "upstream_error"
  | "timeout"
  | "contract_violation";

export class ArchiveAssistantError extends Error {
  readonly kind: ArchiveAssistantErrorKind;

  constructor(kind: ArchiveAssistantErrorKind, message: string) {
    super(message);
    this.name = "ArchiveAssistantError";
    this.kind = kind;
  }
}

/** ARCHIVE_ASSISTANT_API_URL (or a required companion variable) is missing or
 *  invalid. There is deliberately no localhost fallback: the bridge fails
 *  closed instead of silently talking to the wrong service. */
export class ArchiveAssistantConfigError extends ArchiveAssistantError {
  constructor(message: string) {
    super("not_configured", message);
    this.name = "ArchiveAssistantConfigError";
  }
}

/** Arena is in bearer-forwarding mode but the incoming request carried no
 *  bearer token to forward. Maps to 401 at the route boundary. */
export class ArchiveAssistantAuthRequiredError extends ArchiveAssistantError {
  constructor(message = "An authenticated Arena session is required to read archive context.") {
    super("auth_required", message);
    this.name = "ArchiveAssistantAuthRequiredError";
  }
}

/** Archive Assistant rejected the forwarded credentials (HTTP 401/403). The
 *  owner cannot be derived, so no owner-scoped data may be returned. */
export class ArchiveAssistantUpstreamAuthError extends ArchiveAssistantError {
  readonly status: number;

  constructor(status: number, operation: string) {
    super(
      "upstream_auth_failed",
      `Archive Assistant rejected the forwarded credentials for ${operation} (HTTP ${status}).`,
    );
    this.name = "ArchiveAssistantUpstreamAuthError";
    this.status = status;
  }
}

/** The requested owner-scoped object does not exist upstream (HTTP 404). */
export class ArchiveAssistantNotFoundError extends ArchiveAssistantError {
  constructor(operation: string) {
    super("not_found", `Archive Assistant returned 404 for ${operation}.`);
    this.name = "ArchiveAssistantNotFoundError";
  }
}

/** Any other non-2xx upstream response. Carries the status only — never the
 *  response body, which could contain upstream internals. */
export class ArchiveAssistantApiError extends ArchiveAssistantError {
  readonly status: number;

  constructor(status: number, operation: string) {
    super("upstream_error", `Archive Assistant ${operation} failed with HTTP ${status}.`);
    this.name = "ArchiveAssistantApiError";
    this.status = status;
  }
}

/** The upstream call exceeded the bounded timeout. */
export class ArchiveAssistantTimeoutError extends ArchiveAssistantError {
  constructor(operation: string, timeoutMs: number) {
    super("timeout", `Archive Assistant ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "ArchiveAssistantTimeoutError";
  }
}

/** The upstream response did not satisfy the generated OpenAPI contract
 *  subset. Failing closed here is what lets Arena trust the facts it later
 *  reasons over. */
export class ArchiveAssistantContractError extends ArchiveAssistantError {
  readonly schemaName: string;
  readonly schemaPath: string;

  constructor(schemaName: string, schemaPath: string, detail: string) {
    super(
      "contract_violation",
      `Archive Assistant response violates the ${schemaName} contract at ${schemaPath}: ${detail}.`,
    );
    this.name = "ArchiveAssistantContractError";
    this.schemaName = schemaName;
    this.schemaPath = schemaPath;
  }
}

export function isArchiveAssistantError(error: unknown): error is ArchiveAssistantError {
  return error instanceof ArchiveAssistantError;
}
