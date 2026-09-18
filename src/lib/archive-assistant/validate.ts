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
 */

import { archiveSchemas } from "./generated/contract";
import { ArchiveAssistantContractError } from "./errors";

type SchemaNode = Record<string, unknown>;

const schemas = archiveSchemas as unknown as Record<string, SchemaNode>;

function refName(ref: unknown): string | null {
  return typeof ref === "string" && ref.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : null;
}

function typeList(schema: SchemaNode): string[] {
  const t = schema.type;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (typeof t === "string") return [t];
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(rootSchema: string, path: string, detail: string): never {
  throw new ArchiveAssistantContractError(rootSchema, path || "$", detail);
}

function checkValue(rootSchema: string, schema: SchemaNode, value: unknown, path: string): void {
  const ref = refName(schema.$ref);
  if (ref) {
    const target = schemas[ref];
    if (!target) fail(rootSchema, path, `unresolvable $ref ${ref}`);
    return checkValue(rootSchema, target, value, path);
  }

  if (value === null) {
    const nullable = schema.nullable === true || typeList(schema).includes("null");
    if (!nullable) fail(rootSchema, path, "null is not allowed");
    return;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    // Members are tried independently; at least one must accept the value.
    // Contract members are disjoint in this boundary, so "any pass" is exact.
    let lastError: unknown = null;
    for (const member of schema.oneOf as SchemaNode[]) {
      try {
        checkValue(rootSchema, member, value, path);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ArchiveAssistantContractError(rootSchema, path || "$", "no oneOf branch accepts the value");
  }

  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf as SchemaNode[]) checkValue(rootSchema, member, value, path);
  }

  if (schema.const !== undefined && value !== schema.const) {
    fail(rootSchema, path, `expected const ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!(schema.enum as unknown[]).includes(value)) {
      fail(rootSchema, path, `expected one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`);
    }
    return; // enum fully constrains the value
  }

  const types = typeList(schema).filter((t) => t !== "null");
  const primary =
    types[0] ?? (schema.properties || schema.additionalProperties ? "object" : undefined);
  if (!primary) return; // unconstrained

  switch (primary) {
    case "string":
      if (typeof value !== "string") fail(rootSchema, path, `expected string, got ${typeof value}`);
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(rootSchema, path, `expected number, got ${typeof value}`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(rootSchema, path, `expected boolean, got ${typeof value}`);
      return;
    case "array": {
      if (!Array.isArray(value)) fail(rootSchema, path, `expected array, got ${typeof value}`);
      const items = (schema.items ?? {}) as SchemaNode;
      for (let i = 0; i < value.length; i++) {
        checkValue(rootSchema, items, value[i], `${path}[${i}]`);
      }
      return;
    }
    case "object": {
      if (!isPlainObject(value)) fail(rootSchema, path, `expected object, got ${typeof value}`);
      const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      for (const key of required) {
        if (!(key in value) || value[key] === undefined) {
          fail(rootSchema, path, `missing required property "${key}"`);
        }
      }
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in value && value[key] !== undefined) {
          checkValue(rootSchema, propSchema, value[key], path ? `${path}.${key}` : key);
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Validate `value` against a named component schema from the generated
 *  read-only subset. Throws ArchiveAssistantContractError on violation. */
export function validateContract(schemaName: string, value: unknown): void {
  const schema = schemas[schemaName];
  if (!schema) {
    throw new ArchiveAssistantContractError(schemaName, "$", "schema not present in generated subset");
  }
  checkValue(schemaName, schema, value, "");
}

/** The response schema names this bridge is allowed to validate — derived
 *  from the generated operation table, never typed by hand. */
export { archiveSchemas };
