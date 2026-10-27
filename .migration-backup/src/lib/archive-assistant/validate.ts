/**
 * Runtime contract validator for the Archive Assistant read-only bridge.
 *
 * Every upstream response is checked against the AUTO-GENERATED OpenAPI
 * subset in ./generated/contract.ts before it is allowed to influence Arena
 * reasoning. This is the "generated contract, not guessed shapes" guarantee:
 * if the upstream service changes a response incompatibly, the bridge fails
 * closed with a contract violation instead of feeding Arena corrupted facts.
 *
 * Semantics: structural validation only — types, enums, consts, required
 * properties, nullability, arrays, oneOf/allOf. Unknown extra properties are
 * tolerated (forward compatibility); missing or mistyped contract data is
 * not. Numeric min/max bounds from the spec are advisory and not enforced.
 *
 * The checking algorithm itself is shared machinery in
 * ../contract-validation.ts (also used by the Gate-6 personalisation seam).
 */

import { createContractValidator } from "../contract-validation";
import { archiveSchemas } from "./generated/contract";
import { ArchiveAssistantContractError } from "./errors";

const validator = createContractValidator(
  archiveSchemas as unknown as Record<string, unknown>,
  (schemaName, path, detail) => new ArchiveAssistantContractError(schemaName, path, detail),
);

/** Validate `value` against a named component schema from the generated
 *  read-only subset. Throws ArchiveAssistantContractError on violation. */
export function validateContract(schemaName: string, value: unknown): void {
  validator.validate(schemaName, value);
}

/** The response schema names this bridge is allowed to validate — derived
 *  from the generated operation table, never typed by hand. */
export { archiveSchemas };
