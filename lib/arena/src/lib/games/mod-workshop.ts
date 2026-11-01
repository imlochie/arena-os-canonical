import { applyBps, applyIps, PATCH_LIMIT } from "./mod-patches";
export { applyBps, applyIps, crc32 } from "./mod-patches";
export type Setting = { type: "string" | "number" | "boolean"; default: string | number | boolean; min?: number; max?: number };
export type ModOperation = { kind: "replace" | "ips" | "bps" | "config-json"; target: string; payload: string; baseSha256: string; resultSha256?: string; afterMod?: string };
export type ModManifest = {
  schema: "arena.arcade.mod"; schemaVersion: 1; id: string; name: string; version: string;
  license: { spdx: string; text: string; redistributable: boolean };
  source: { kind: "local" | "repository"; url?: string; revision?: string };
  base: { id: string; version: string; files: Record<string, string> };
  adapter: "files" | "ips" | "bps" | "ups" | "xdelta" | "plugin";
  permissions: string[]; requires: { id: string; range: string }[]; conflicts: string[]; after: string[];
  settings: Record<string, Setting>; operations: ModOperation[]; payloads: Record<string, string>;
};
export type ModPackage = { manifest: ModManifest; files: Record<string, Uint8Array>; digest: string };
export type ModProfile = { id: string; name: string; enabled: string[]; order: string[]; settings: Record<string, Record<string, string | number | boolean>>; shareSaves: boolean };
export type ModBase = { id: string; version: string; kind: string; files: Record<string, Uint8Array> };
const hashPattern = /^[a-f0-9]{64}$/, idPattern = /^[a-z0-9][a-z0-9.-]{0,79}$/, versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
function object(value: unknown): asserts value is Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a manifest object."); }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown manifest field or executable hook."); }
function text(value: unknown, max = 200): asserts value is string { if (typeof value !== "string" || !value.length || value.length > max || /[\0]/.test(value)) throw new Error("Invalid manifest text."); }
function strings(value: unknown, max = 64): asserts value is string[] { if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || item.length > 200)) throw new Error("Invalid manifest list."); }
export function safeModPath(value: string) {
  text(value, 180);
  if (!/^[A-Za-z0-9 _./-]+$/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ["__proto__", "constructor", "prototype", ".git"].includes(part.toLowerCase()))) throw new Error("Unsafe mod path.");
  return value;
}
export async function modHash(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function modKey(mod: ModPackage) { return `${mod.manifest.id}@${mod.manifest.version}`; }
function cmp(a: string, b: string) { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
export function versionMatches(version: string, range: string) {
  if (!versionPattern.test(version) || typeof range !== "string" || range.length > 100) return false;
  if (range === "*") return true;
  return range.trim().split(/\s+/).every(token => {
    const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token); if (!match || !versionPattern.test(match[2])) return false;
    const difference = cmp(version, match[2]), [major, minor, patch] = match[2].split(".").map(Number);
    switch (match[1]) {
      case "^": return difference >= 0 && cmp(version, major ? `${major + 1}.0.0` : minor ? `0.${minor + 1}.0` : `0.0.${patch + 1}`) < 0;
      case "~": return difference >= 0 && cmp(version, `${major}.${minor + 1}.0`) < 0;
      case ">=": return difference >= 0; case "<=": return difference <= 0; case ">": return difference > 0; case "<": return difference < 0;
      default: return difference === 0;
    }
  });
}
export function validateModManifest(value: unknown): ModManifest {
  object(value); keys(value, ["schema", "schemaVersion", "id", "name", "version", "license", "source", "base", "adapter", "permissions", "requires", "conflicts", "after", "settings", "operations", "payloads"]);
  if (value.schema !== "arena.arcade.mod" || value.schemaVersion !== 1 || !idPattern.test(value.id) || !versionPattern.test(value.version)) throw new Error("Unsupported mod identity/schema/version.");
  text(value.name, 100); object(value.license); keys(value.license, ["spdx", "text", "redistributable"]); text(value.license.spdx, 100); text(value.license.text, 65536);
  if (typeof value.license.redistributable !== "boolean") throw new Error("Declare whether the mod's own payload may be redistributed.");
  object(value.source); keys(value.source, ["kind", "url", "revision"]);
  if (!["local", "repository"].includes(value.source.kind)) throw new Error("Invalid mod source.");
  if (value.source.url !== undefined) { text(value.source.url, 1000); const url = new URL(value.source.url); if (url.protocol !== "https:" || url.username || url.password) throw new Error("Mod source must be an HTTPS provenance URL."); }
  if (value.source.revision !== undefined && !/^[a-f0-9]{40}$/.test(value.source.revision)) throw new Error("Repository revision must be pinned.");
  object(value.base); keys(value.base, ["id", "version", "files"]); text(value.base.id, 200);
  if (!/^sha256:[a-f0-9]{64}$/.test(value.base.version)) throw new Error("Mods must pin an exact base version SHA256.");
  object(value.base.files); object(value.payloads);
  for (const entries of [value.base.files, value.payloads]) {
    if (Object.keys(entries).length > 128) throw new Error("Too many mod files.");
    const seen = new Set<string>();
    for (const [path, hash] of Object.entries(entries)) { safeModPath(path); if (seen.has(path.toLowerCase())) throw new Error("Case-colliding mod paths."); seen.add(path.toLowerCase()); if (hash !== "absent" && !hashPattern.test(String(hash))) throw new Error("Invalid file hash."); }
  }
  if (!["files", "ips", "bps", "ups", "xdelta", "plugin"].includes(value.adapter)) throw new Error("Unknown mod adapter.");
  strings(value.permissions); if (value.permissions.some((p: string) => !["assets", "configuration", "scripts", "patch-binary"].includes(p))) throw new Error("Unsupported mod permission.");
  strings(value.conflicts); strings(value.after);
  if ([...value.conflicts, ...value.after].some(id => !idPattern.test(id))) throw new Error("Invalid mod relationship.");
  if (!Array.isArray(value.requires) || value.requires.length > 32) throw new Error("Too many dependencies.");
  for (const dependency of value.requires) { object(dependency); keys(dependency, ["id", "range"]); if (!idPattern.test(dependency.id)) throw new Error("Invalid dependency."); text(dependency.range, 100); if (!/^(?:\*|(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:\s+(?:>=|<=|>|<|=)?\d+\.\d+\.\d+)*)$/.test(dependency.range)) throw new Error("Unsupported version range."); }
  object(value.settings); if (Object.keys(value.settings).length > 32) throw new Error("Too many settings.");
  for (const [name, setting] of Object.entries(value.settings)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error("Invalid setting key.");
    object(setting); keys(setting, ["type", "default", "min", "max"]);
    if (!["string", "number", "boolean"].includes(setting.type) || typeof setting.default !== setting.type || (setting.type === "string" && setting.default.length > 200) || (setting.type === "number" && !Number.isFinite(setting.default))) throw new Error("Invalid setting default.");
    for (const bound of ["min", "max"]) if (setting[bound] !== undefined && (setting.type !== "number" || !Number.isFinite(setting[bound]))) throw new Error("Invalid setting bounds.");
    if (setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) throw new Error("Invalid setting bounds.");
  }
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 64) throw new Error("A mod needs 1–64 declared operations.");
  const targets = new Set<string>();
  for (const operation of value.operations) {
    object(operation); keys(operation, ["kind", "target", "payload", "baseSha256", "resultSha256", "afterMod"]); safeModPath(operation.target); safeModPath(operation.payload);
    if (!["replace", "ips", "bps", "config-json"].includes(operation.kind) || !Object.hasOwn(value.payloads, operation.payload) || !Object.hasOwn(value.base.files, operation.target)) throw new Error("Every operation needs a declared payload and base target.");
    if (targets.has(operation.target.toLowerCase())) throw new Error("Duplicate mod target."); targets.add(operation.target.toLowerCase());
    if (operation.baseSha256 !== "absent" && !hashPattern.test(operation.baseSha256)) throw new Error("Each operation must verify its input SHA256.");
    if (operation.kind !== "config-json" && !hashPattern.test(operation.resultSha256)) throw new Error("Each patch/replacement must verify its result SHA256.");
    if (operation.afterMod !== undefined && !idPattern.test(operation.afterMod)) throw new Error("Invalid explicit override.");
    if (/\.(?:exe|dll|sys|com|bat|cmd|ps1|vbs|msi|lnk|reg)$/i.test(operation.target)) throw new Error("Executable/native loader replacement requires a separate adapter.");
    const permission = operation.kind === "config-json" ? "configuration" : operation.kind === "ips" || operation.kind === "bps" ? "patch-binary" : /\.(?:js|lua|gd|py|cfgscript)$/i.test(operation.target) ? "scripts" : "assets";
    if (!value.permissions.includes(permission)) throw new Error(`Declare ${permission} permission for ${operation.target}.`);
  }
  return value as ModManifest;
}
export async function parseModPackage(json: string): Promise<ModPackage> {
  if (typeof json !== "string" || json.length > 24 * 1024 * 1024) throw new Error("Mod packages are limited to 24 MiB JSON / 16 MiB decoded payload.");
  const raw = JSON.parse(json); object(raw); keys(raw, ["manifest", "files"]); const manifest = validateModManifest(raw.manifest); object(raw.files);
  if (Object.keys(raw.files).length !== Object.keys(manifest.payloads).length) throw new Error("Mod payload inventory differs from its manifest.");
  const files: Record<string, Uint8Array> = Object.create(null); let total = 0;
  for (const path of Object.keys(raw.files).sort()) {
    if (!Object.hasOwn(manifest.payloads, path) || typeof raw.files[path] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.files[path])) throw new Error("Invalid mod payload encoding.");
    const binary = atob(raw.files[path]); total += binary.length; if (total > 16 * 1024 * 1024) throw new Error("Decoded mod payload exceeds 16 MiB.");
    files[path] = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (await modHash(files[path]) !== manifest.payloads[path]) throw new Error(`Corrupt mod payload: ${path}.`);
  }
  const mod = { manifest, files, digest: "" };
  mod.digest = await modHash(encodeModPackage(mod)); return mod;
}
export function encodeModPackage(mod: ModPackage) {
  const files: Record<string, string> = Object.create(null);
  for (const [path, bytes] of Object.entries(mod.files)) { let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); files[path] = btoa(binary); }
  return JSON.stringify({ manifest: mod.manifest, files });
}
export function resolveMods(packages: ModPackage[], profile: ModProfile) {
  if (packages.length > 64 || profile.enabled.length > 32 || profile.order.length > 64) throw new Error("Too many mods.");
  const inventory = new Map(packages.map(mod => [modKey(mod), mod])), selected = new Map<string, ModPackage>(), added: string[] = [];
  const add = (key: string) => {
    const mod = inventory.get(key); if (!mod) throw new Error(`Missing mod package ${key}.`);
    const other = selected.get(mod.manifest.id); if (other && modKey(other) !== key) throw new Error(`Conflicting versions of ${mod.manifest.id}.`);
    selected.set(mod.manifest.id, mod); return mod;
  };
  for (const key of profile.enabled) add(key);
  for (const mod of selected.values()) for (const dependency of mod.manifest.requires) {
    const existing = selected.get(dependency.id);
    if (existing) { if (!versionMatches(existing.manifest.version, dependency.range)) throw new Error(`Incompatible dependency: ${dependency.id} ${dependency.range}.`); }
    else {
      const candidate = packages.filter(item => item.manifest.id === dependency.id && versionMatches(item.manifest.version, dependency.range)).sort((a, b) => cmp(b.manifest.version, a.manifest.version))[0];
      if (!candidate) throw new Error(`Missing dependency ${dependency.id} ${dependency.range}.`);
      add(modKey(candidate)); added.push(modKey(candidate));
    }
  }
  for (const mod of selected.values()) for (const id of mod.manifest.conflicts) if (selected.has(id)) throw new Error(`${mod.manifest.id} conflicts with ${id}.`);
  const result: ModPackage[] = [], visiting = new Set<string>(), done = new Set<string>();
  const preference = (mod: ModPackage) => { const i = profile.order.indexOf(modKey(mod)); return i < 0 ? 1000 : i; };
  const ordered = [...selected.values()].sort((a, b) => preference(a) - preference(b) || modKey(a).localeCompare(modKey(b), "en"));
  const visit = (mod: ModPackage) => {
    const id = mod.manifest.id; if (done.has(id)) return; if (visiting.has(id)) throw new Error(`Dependency/load-order cycle at ${id}.`);
    visiting.add(id);
    const predecessors = [...mod.manifest.requires.map(item => item.id), ...mod.manifest.after, ...mod.manifest.operations.map(op => op.afterMod).filter((id): id is string => !!id)].sort();
    for (const before of predecessors) { const dependency = selected.get(before); if (dependency) visit(dependency); else if (mod.manifest.operations.some(op => op.afterMod === before)) throw new Error(`Missing override predecessor ${before}.`); }
    visiting.delete(id); done.add(id); result.push(mod);
  };
  ordered.forEach(visit); return { mods: result, added };
}
export function settingsFor(mod: ModPackage, input: Record<string, string | number | boolean> = {}) {
  if (Object.keys(input).some(key => !Object.hasOwn(mod.manifest.settings, key))) throw new Error("Unknown mod setting.");
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const [key, definition] of Object.entries(mod.manifest.settings)) {
    const value = input[key] ?? definition.default;
    if (typeof value !== definition.type || (typeof value === "string" && value.length > 200) || (typeof value === "number" && (!Number.isFinite(value) || value < (definition.min ?? -Infinity) || value > (definition.max ?? Infinity)))) throw new Error(`Invalid setting ${key}.`);
    result[key] = value;
  }
  return result;
}
function configure(bytes: Uint8Array, settings: Record<string, unknown>) {
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const visit = (value: any, depth: number): any => {
    if (depth > 20) throw new Error("Configuration template is too deep.");
    if (typeof value === "string") {
      const match = /^\{\{settings\.([a-z][a-z0-9_]*)\}\}$/.exec(value);
      if (match) { if (!Object.hasOwn(settings, match[1])) throw new Error("Unknown configuration setting."); return settings[match[1]]; }
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === "object") { const out: Record<string, unknown> = Object.create(null); for (const [key, item] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe configuration key."); out[key] = visit(item, depth + 1); } return out; }
    return value;
  };
  return new TextEncoder().encode(JSON.stringify(visit(raw, 0)));
}
export async function composeMods(base: ModBase, packages: ModPackage[], profile: ModProfile) {
  const resolved = resolveMods(packages, profile), files: Record<string, Uint8Array> = Object.assign(Object.create(null), base.files);
  const originalHashes: Record<string, string> = Object.create(null), owners = new Map<string, string>();
  const changes: { path: string; before: string; after: string; bytes: number; mod: string }[] = [];
  const caseNames = new Map<string, string>();
  for (const [path, bytes] of Object.entries(files)) { safeModPath(path); if (caseNames.has(path.toLowerCase())) throw new Error("Case-colliding base paths."); caseNames.set(path.toLowerCase(), path); originalHashes[path] = await modHash(bytes); }
  for (const mod of resolved.mods) {
    const m = mod.manifest;
    if (m.base.id !== base.id || m.base.version !== base.version) throw new Error(`${m.name} requires a different base game/version.`);
    if (["ups", "xdelta", "plugin"].includes(m.adapter)) throw new Error(`${m.adapter} adapter is not installed. No generic loader or install script is executed.`);
    for (const [path, hash] of Object.entries(m.base.files)) if ((originalHashes[path] ?? "absent") !== hash) throw new Error(`Base file checksum mismatch: ${path}.`);
    const settings = settingsFor(mod, profile.settings[modKey(mod)]);
    for (const operation of m.operations) {
      const path = operation.target, lower = path.toLowerCase(), owner = owners.get(lower);
      if (caseNames.has(lower) && caseNames.get(lower) !== path) throw new Error("Case-colliding overlay target.");
      if (owner && operation.afterMod !== owner) throw new Error(`File conflict: ${path} is changed by ${owner} and ${m.id}; an explicit ordered override is required.`);
      if (!owner && operation.afterMod) throw new Error(`Override predecessor did not write ${path}.`);
      const before = files[path] ? await modHash(files[path]) : "absent";
      if (before !== operation.baseSha256) throw new Error(`Patch input checksum mismatch: ${path}.`);
      const payload = mod.files[operation.payload];
      if (!payload || await modHash(payload) !== m.payloads[operation.payload]) throw new Error("Mod payload integrity changed.");
      if ((operation.kind === "ips" || operation.kind === "bps") && !files[path]) throw new Error("Binary patches need an existing authorized base file.");
      const result = operation.kind === "ips" ? applyIps(files[path], payload) : operation.kind === "bps" ? applyBps(files[path], payload) : operation.kind === "config-json" ? configure(payload, settings) : new Uint8Array(payload);
      if (result.length > PATCH_LIMIT) throw new Error("Overlay output exceeds 64 MiB.");
      const after = await modHash(result);
      if (operation.resultSha256 && operation.resultSha256 !== after) throw new Error(`Patch result checksum mismatch: ${path}.`);
      files[path] = result; caseNames.set(lower, path); owners.set(lower, m.id);
      changes.push({ path, before, after, bytes: result.length, mod: modKey(mod) });
    }
  }
  const inventory = await Promise.all(Object.keys(files).sort().map(async path => [path, await modHash(files[path])]));
  return { files, changes, order: resolved.mods.map(modKey), addedDependencies: resolved.added, version: `sha256:${await modHash(JSON.stringify(inventory))}` };
}
