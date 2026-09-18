#!/usr/bin/env node
/**
 * generate-archive-assistant-contract.mjs
 *
 * Regenerates Arena's read-only Archive Assistant contract from the upstream
 * Archive Assistant OpenAPI document (the single source of truth).
 *
 * Source of truth:
 *   SomeSafePortablesoftware → lib/api-spec/openapi.yaml
 *
 * Outputs (both AUTO-GENERATED — never hand-edit):
 *   src/lib/archive-assistant/generated/contract.ts  (operations + schemas snapshot)
 *   src/lib/archive-assistant/generated/types.ts     (TypeScript types)
 *
 * Usage:
 *   node scripts/generate-archive-assistant-contract.mjs [--spec <path-or-url>]
 *       [--ref <git-ref>] [--source-label <label>] [--check]
 *
 *   --spec   Local path or http(s) URL of openapi.yaml.
 *            Default: raw GitHub URL built from --repo + --ref.
 *   --repo   Upstream repo (default: imlochie/SomeSafePortablesoftware).
 *   --ref    Git ref of the upstream spec (default: main).
 *            NOTE: the read-only assistant boundary lands on main via the
 *            branch arena/01a0a0d9-somesafeportablesoftware. The committed
 *            snapshot was generated from that branch; once it merges, plain
 *            `--ref main` reproduces it.
 *   --check  Do not write files; fail if committed output is stale.
 *
 * The script is dependency-free: it carries a small YAML reader that covers
 * the OpenAPI authoring style used upstream (block maps/sequences, inline
 * flow collections, quoted and plain scalars, literal block scalars).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "src/lib/archive-assistant/generated");

/** The official read-only seam. Nothing outside this list is ever generated,
 *  keeping mutation/control-plane surface out of Arena by construction. */
const READ_ONLY_OPERATIONS = [
  { operationId: "getAssistantOverview", method: "get", path: "/assistant/overview" },
  { operationId: "getAssistantWorkload", method: "get", path: "/assistant/workload" },
  { operationId: "getArchiveReconciliation", method: "get", path: "/archive/reconciliation" },
  { operationId: "getReconciliationFindingLineage", method: "get", path: "/archive/reconciliation/findings/{reviewItemId}/lineage" },
  { operationId: "getProviderRefreshState", method: "get", path: "/provider/refresh" },
  { operationId: "listProviderRefreshHistory", method: "get", path: "/provider/refresh/history" },
];

/* ------------------------------------------------------------------------ */
/* Minimal YAML reader (OpenAPI authoring subset)                            */
/* ------------------------------------------------------------------------ */

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && ch === "\\") i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function lineIndent(line) {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function splitFlow(text) {
  // Split a flow collection body on top-level commas (quote/nest aware).
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && ch === "\\") i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitKeyValue(text) {
  // Split "key: value" on the first top-level ":" followed by space/EOL.
  let depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && ch === "\\") i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === ":" && depth === 0 && (i + 1 === text.length || text[i + 1] === " ")) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return [text.trim(), null];
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function parseInline(text) {
  text = text.trim();
  const quoted = unquote(text);
  if (quoted !== null) return quoted;
  if (text.startsWith("{") && text.endsWith("}")) {
    const out = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const [k, v] = splitKeyValue(part);
      out[unquote(k) ?? k] = v === null ? null : parseInline(v);
    }
    return out;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitFlow(text.slice(1, -1)).map(parseInline);
  }
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseYamlBlock(lines, start, indent) {
  let i = start;
  // Skip blanks/comments to find container kind.
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lineIndent(lines[i]) < indent) return [null, i];
  const isSeq = lines[i].trimStart().startsWith("- ") || lines[i].trim() === "-";
  const out = isSeq ? [] : {};

  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") { i++; continue; }
    const ind = lineIndent(raw);
    if (ind < indent) break;
    const text = raw.trimStart();

    if (isSeq) {
      if (!(text.startsWith("- ") || text === "-")) break;
      if (ind !== indent) break;
      const content = text === "-" ? "" : text.slice(2);
      const looksLikeMap = content !== "" && !content.startsWith("{") && !content.startsWith("[")
        && splitKeyValue(content)[1] !== null;
      if (looksLikeMap || content === "") {
        // Rewrite the dash as indentation and parse a map starting there.
        lines[i] = " ".repeat(indent + 2) + content;
        const [val, next] = parseYamlBlock(lines, i, indent + 2);
        out.push(val);
        i = next;
      } else {
        out.push(parseInline(content));
        i++;
      }
      continue;
    }

    // Map
    if (text.startsWith("- ") || text === "-") break;
    if (ind !== indent) break;
    const [rawKey, rest] = splitKeyValue(text);
    const key = unquote(rawKey) ?? rawKey;
    if (rest === null || rest === "") {
      // Nested block or null.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lineIndent(lines[j]) > indent) {
        const [val, next] = parseYamlBlock(lines, j, lineIndent(lines[j]));
        out[key] = val;
        i = next;
      } else {
        out[key] = null;
        i++;
      }
      continue;
    }
    if (/^[|>][+-]?$/.test(rest)) {
      // Block scalar: consume raw lines deeper than the key.
      const buf = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lineIndent(lines[j]) > indent)) {
        buf.push(lines[j]);
        j++;
      }
      out[key] = buf.join("\n").trimEnd();
      i = j;
      continue;
    }
    out[key] = parseInline(rest);
    i++;
  }
  return [out, i];
}

function parseYaml(source) {
  const cleaned = source.replace(/\r\n/g, "\n").split("\n").map(stripComment);
  const [doc] = parseYamlBlock(cleaned, 0, 0);
  return doc;
}

/* ------------------------------------------------------------------------ */
/* OpenAPI subset extraction                                                 */
/* ------------------------------------------------------------------------ */

function refName(ref) {
  return typeof ref === "string" && ref.startsWith("#/components/schemas/")
    ? ref.split("/").pop()
    : null;
}

function collectRefs(node, into) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) collectRefs(item, into); return; }
  const name = refName(node.$ref);
  if (name) into.add(name);
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref") continue;
    collectRefs(v, into);
  }
}

function simplifyParameter(param) {
  const schema = param.schema ?? {};
  return {
    name: param.name,
    in: param.in,
    required: param.required === true,
    ...(schema.type !== undefined ? { type: schema.type } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
    ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
  };
}

function extractSubset(doc, operations) {
  const schemas = doc?.components?.schemas ?? {};
  const parameters = doc?.components?.parameters ?? {};
  const extracted = {};
  const needed = new Set();

  const missing = [];
  for (const op of operations) {
    const pathItem = doc?.paths?.[op.path];
    const spec = pathItem?.[op.method];
    if (!spec || spec.operationId !== op.operationId) {
      missing.push(`${op.operationId} (${op.method.toUpperCase()} ${op.path})`);
      continue;
    }
    const responseSchema = spec?.responses?.["200"]?.content?.["application/json"]?.schema ?? null;
    const name = refName(responseSchema?.$ref);
    if (!name) { missing.push(`${op.operationId} (unresolvable 200 schema)`); continue; }
    needed.add(name);
    const params = (spec.parameters ?? [])
      .map((p) => {
        if (typeof p?.$ref === "string" && p.$ref.startsWith("#/components/parameters/")) {
          const refKey = p.$ref.split("/").pop();
          return parameters[refKey] ?? null;
        }
        return p;
      })
      .filter(Boolean)
      .map(simplifyParameter);
    extracted[op.operationId] = {
      method: op.method.toUpperCase(),
      path: op.path,
      response: name,
      ...(params.length ? { parameters: params } : {}),
    };
  }
  if (missing.length) {
    throw new Error(
      "The upstream spec does not expose the read-only assistant boundary:\n  - "
      + missing.join("\n  - ")
      + "\nUse a ref that contains it (see header note in this script).",
    );
  }

  // Transitive closure over schema refs.
  const closure = new Set(needed);
  const queue = [...needed];
  while (queue.length) {
    const current = queue.pop();
    const schema = schemas[current];
    if (!schema) throw new Error(`Spec references missing schema: ${current}`);
    const refs = new Set();
    collectRefs(schema, refs);
    for (const ref of refs) {
      if (!closure.has(ref)) { closure.add(ref); queue.push(ref); }
    }
  }

  const outSchemas = {};
  for (const name of [...closure].sort()) outSchemas[name] = schemas[name];
  return { operations: extracted, schemas: outSchemas };
}

/* ------------------------------------------------------------------------ */
/* TypeScript emission                                                       */
/* ------------------------------------------------------------------------ */

function tsLiteral(value) {
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(String(value));
}

function normalizeTypeList(schema) {
  const t = schema?.type;
  if (Array.isArray(t)) return t;
  if (typeof t === "string") return [t];
  return [];
}

function renderSchema(schema, schemas, depth) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) return refName(schema.$ref) ?? "unknown";

  const pad = "  ".repeat(depth);
  const padIn = "  ".repeat(depth + 1);
  const nullable = schema.nullable === true || normalizeTypeList(schema).includes("null");
  const suffix = nullable ? " | null" : "";

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map((s) => renderSchema(s, schemas, depth)).join(" | ") + suffix;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((s) => renderSchema(s, schemas, depth)).join(" & ") + suffix;
  }
  if (schema.const !== undefined) return tsLiteral(schema.const) + suffix;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(tsLiteral).join(" | ") + suffix;
  }

  const types = normalizeTypeList(schema).filter((t) => t !== "null");
  const primary = types[0] ?? (schema.properties || schema.additionalProperties ? "object" : null);
  if (primary === null && nullable) return "null";

  switch (primary) {
    case "string":
      return "string" + suffix;
    case "number":
    case "integer":
      return "number" + suffix;
    case "boolean":
      return "boolean" + suffix;
    case "array":
      return `Array<${renderSchema(schema.items ?? {}, schemas, depth)}>` + suffix;
    case "object": {
      const props = schema.properties ?? {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const keys = Object.keys(props);
      if (keys.length === 0) {
        if (schema.additionalProperties) return "Record<string, unknown>" + suffix;
        return "Record<string, unknown>" + suffix;
      }
      const lines = keys.map((k) => {
        const opt = required.has(k) ? "" : "?";
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        return `${padIn}${safeKey}${opt}: ${renderSchema(props[k], schemas, depth + 1)};`;
      });
      if (schema.additionalProperties === true) lines.push(`${padIn}[key: string]: unknown;`);
      return `{\n${lines.join("\n")}\n${pad}}` + suffix;
    }
    default:
      return "unknown" + suffix;
  }
}

function emitTypesTs(meta, schemas) {
  const names = Object.keys(schemas).sort();
  const body = names
    .map((name) => `export type ${name} = ${renderSchema(schemas[name], schemas, 0)};`)
    .join("\n\n");
  return `${header(meta)}
/**
 * AUTO-GENERATED TypeScript types for the Archive Assistant read-only boundary.
 * Mirrors the OpenAPI component schemas referenced by the six sanctioned
 * read-only operations. Regenerate; never hand-edit.
 */

${body}
`;
}

function emitContractTs(meta, subset) {
  return `${header(meta)}
/**
 * AUTO-GENERATED machine-readable snapshot of the Archive Assistant read-only
 * OpenAPI subset: the six sanctioned GET operations plus the transitive
 * closure of their component schemas. The runtime validator
 * (../validate.ts) checks every upstream response against this snapshot.
 * Regenerate; never hand-edit.
 */

export const archiveContractMeta = ${JSON.stringify(meta, null, 2)};

export const archiveReadOnlyOperations = ${JSON.stringify(subset.operations, null, 2)};

export const archiveSchemas = ${JSON.stringify(subset.schemas, null, 2)};
`;
}

function header(meta) {
  return `/**
 * -----------------------------------------------------------------------------
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth : ${meta.sourceSpec}
 * Upstream ref    : ${meta.sourceRef}
 *
 * Byte-for-byte reproducible: regenerate whenever the upstream OpenAPI
 * document changes (npm run generate:archive-contract), then commit both
 * generated files together. The --check mode fails if the committed output
 * is stale with respect to the given spec.
 *   npm run generate:archive-contract
 * -----------------------------------------------------------------------------
 */`;
}

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

async function readSpec(args) {
  if (args.spec && /^https?:\/\//.test(args.spec)) {
    const res = await fetch(args.spec);
    if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status} from ${args.spec}`);
    return { text: await res.text(), label: args.spec };
  }
  if (args.spec) {
    const path = resolve(args.spec);
    return { text: readFileSync(path, "utf8"), label: path };
  }
  const url = `https://raw.githubusercontent.com/${args.repo}/${args.ref}/lib/api-spec/openapi.yaml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status} from ${url}`);
  return { text: await res.text(), label: url };
}

function parseArgs(argv) {
  const args = { spec: null, repo: "imlochie/SomeSafePortablesoftware", ref: "main", check: false, sourceLabel: null, sourceRef: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--spec") args.spec = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--source-label") args.sourceLabel = argv[++i];
    else if (a === "--source-ref") args.sourceRef = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { text, label } = await readSpec(args);
const doc = parseYaml(text);
if (!doc?.paths || !doc?.components?.schemas) {
  throw new Error("Parsed document does not look like an OpenAPI spec (missing paths/components).");
}
const subset = extractSubset(doc, READ_ONLY_OPERATIONS);
// Note: no timestamp is recorded — output is byte-for-byte reproducible from
// (spec content, ref), which is what makes `npm run check:archive-contract`
// (a --check diff against the committed files) meaningful.
const meta = {
  sourceSpec: args.sourceLabel ?? label,
  sourceRef: args.sourceRef ?? (args.spec && !/^https?:\/\//.test(args.spec) ? `local:${args.spec}` : `${args.repo}@${args.ref}`),
};

const files = {
  "contract.ts": emitContractTs(meta, subset),
  "types.ts": emitTypesTs(meta, subset.schemas),
};

if (args.check) {
  let stale = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(OUT_DIR, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) stale.push(name);
  }
  if (stale.length) {
    console.error(`Archive Assistant contract is stale: ${stale.join(", ")}`);
    console.error("Run: npm run generate:archive-contract");
    process.exit(1);
  }
  console.log("Archive Assistant contract is up to date.");
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, name), content);
    console.log(`wrote src/lib/archive-assistant/generated/${name} (${content.length} bytes)`);
  }
  console.log(`operations: ${Object.keys(subset.operations).length}, schemas: ${Object.keys(subset.schemas).length}`);
}
