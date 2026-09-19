/**
 * HTTP boundary helpers for the /api/archive/* routes: maps the bridge's
 * error taxonomy onto honest status codes with sanitized bodies.
 */

import {
  ArchiveAssistantConfigError,
  ArchiveAssistantAuthRequiredError,
  ArchiveAssistantUpstreamAuthError,
  ArchiveAssistantNotFoundError,
  ArchiveAssistantTimeoutError,
  ArchiveAssistantContractError,
  ArchiveAssistantApiError,
  isArchiveAssistantError,
} from "./errors";

export function archiveAssistantErrorResponse(error: unknown): Response {
  if (error instanceof ArchiveAssistantConfigError) {
    return Response.json(
      { ok: false, error: "archive_assistant_not_configured", message: error.message },
      { status: 503 },
    );
  }
  if (error instanceof ArchiveAssistantAuthRequiredError) {
    return Response.json(
      { ok: false, error: "auth_required", message: error.message },
      { status: 401 },
    );
  }
  if (error instanceof ArchiveAssistantUpstreamAuthError) {
    // The forwarded identity was rejected upstream: the caller must
    // re-authenticate; no owner-scoped data may be synthesized.
    return Response.json(
      { ok: false, error: "archive_assistant_auth_failed", message: error.message },
      { status: 401 },
    );
  }
  if (error instanceof ArchiveAssistantNotFoundError) {
    return Response.json(
      { ok: false, error: "archive_assistant_not_found", message: error.message },
      { status: 404 },
    );
  }
  if (error instanceof ArchiveAssistantTimeoutError) {
    return Response.json(
      { ok: false, error: "archive_assistant_timeout", message: error.message },
      { status: 504 },
    );
  }
  if (error instanceof ArchiveAssistantContractError) {
    return Response.json(
      { ok: false, error: "archive_assistant_contract_violation", message: error.message },
      { status: 502 },
    );
  }
  if (error instanceof ArchiveAssistantApiError) {
    return Response.json(
      { ok: false, error: "archive_assistant_upstream_error", message: error.message },
      { status: 502 },
    );
  }
  if (isArchiveAssistantError(error)) {
    return Response.json({ ok: false, error: error.kind, message: error.message }, { status: 502 });
  }
  console.error("archive bridge unexpected error");
  return Response.json({ ok: false, error: "archive_context_failed" }, { status: 500 });
}
