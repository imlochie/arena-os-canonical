/**
 * Runtime contract validator for the Gate-6 personalisation-evidence seam.
 *
 * The response of the seventh read (GET /assistant/personalisation-context)
 * is checked against the AUTO-GENERATED OpenAPI subset in
 * ./generated/contract.ts — generated from the owner-verified upstream ref,
 * never hand-authored — before any byte of it is allowed into Arena's
 * reasoning context. If upstream changes the payload incompatibly, the seam
 * fails closed here with a contract violation; Arena never re-derives,
 * repairs, or silently accepts a corrupted evidence envelope.
 *
 * The checking algorithm is shared machinery in ../contract-validation.ts;
 * this module only binds it to the personalisation snapshot and the bridge's
 * contract-error taxonomy.
 */

import { createContractValidator } from "../contract-validation";
import { personalisationSchemas } from "./generated/contract";
import { ArchiveAssistantContractError } from "../archive-assistant/errors";

const validator = createContractValidator(
  personalisationSchemas as unknown as Record<string, unknown>,
  (schemaName, path, detail) => new ArchiveAssistantContractError(schemaName, path, detail),
);

/** Validate `value` against a named component schema from the generated
 *  personalisation subset. Throws ArchiveAssistantContractError on
 *  violation. */
export function validatePersonalisationContract(schemaName: string, value: unknown): void {
  validator.validate(schemaName, value);
}

/** The generated snapshot itself — operations, schemas, and provenance
 *  meta — for tests and introspection. Never typed by hand. */
export { personalisationOperations, personalisationSchemas, personalisationContractMeta } from "./generated/contract";
