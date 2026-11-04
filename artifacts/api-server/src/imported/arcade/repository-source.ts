import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 64;
const TTL_MS = 5 * 60_000;
const licenses = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unlicense", "CC0-1.0", "MPL-2.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "AGPL-3.0"]);
const supportedFile = /\.(?:html?|css|js|json|avif|gif|ico|jpe?g|png|svg|webp|m4a|mp3|mp4|ogg|wav|webm|woff2?|ttf|otf|eot|xml)$/i;
const sha = /^[a-f0-9]{40}$/;
export class RepositoryImportError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
export type RepositoryFile = { path: string; size: number; sha: string };
export type RepositoryProvenance = {
  repository: string; revision: string; sourceUrl: string;
  license: { spdx: string; path: string; text: string };
};
export type RepositoryProvider = "github" | "codeberg";
export type RepositoryPlan = RepositoryProvenance & {
  provider: RepositoryProvider; entryPath: string; files: RepositoryFile[]; totalBytes: number; reference: string;
};
export type ReadBytes = (url: string, limit: number, signal: AbortSignal) => Promise<Buffer>;
export type RepositoryNode = { path: string; mode: string; type: string; size: number; sha: string };

export function parseRepositoryLink(value: string) {
  if (/%(?:2e|2f|5c)/i.test(value) || /\/(?:\.{1,2})(?:\/|[?#]|$)/.test(value)) {
    throw new RepositoryImportError("Encoded separators and dot-path traversal are not supported.", 400);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new RepositoryImportError("Enter a complete HTTPS GitHub or Codeberg repository link.", 400); }
  const provider: RepositoryProvider | null = url.hostname === "github.com" ? "github" : url.hostname === "codeberg.org" ? "codeberg" : null;
  if (url.protocol !== "https:" || !provider || url.port || url.username || url.password || url.search || url.hash) {
    throw new RepositoryImportError("Only public GitHub and Codeberg HTTPS repository links are supported. Queries, credentials and other hosts are not allowed.", 400);
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  const [owner, rawRepo, kind, ref, ...folder] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner ?? "") ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? "") || repo === "." || repo === "..") {
    throw new RepositoryImportError("The repository owner or name is invalid.", 400);
  }
  if (parts.length === 2) return { provider, repository: `${owner}/${repo}`, ref: null, refType: null as "commit" | "branch" | "tag" | null, folder: "" };
  if (kind === "releases" && ref === "tag" && folder.length === 1 && /^[A-Za-z0-9_.-]{1,128}$/.test(folder[0])) {
    return { provider, repository: `${owner}/${repo}`, ref: folder[0], refType: "tag" as const, folder: "" };
  }
  if (provider === "github" && kind === "tree" && sha.test(ref ?? "") && folder.every(safePathSegment)) {
    return { provider, repository: `${owner}/${repo}`, ref, refType: "commit" as const, folder: folder.length ? `${folder.join("/")}/` : "" };
  }
  if (provider === "codeberg" && kind === "src" && ["commit", "branch"].includes(ref ?? "") &&
      folder.length >= 1 && folder.every(safePathSegment)) {
    const [refName, ...subfolder] = folder;
    const refType = ref as "commit" | "branch";
    if (refType === "commit" && !sha.test(refName)) throw new RepositoryImportError("Use a 40-character pinned Codeberg commit.", 400);
    if (refType === "branch" && (!refName || refName.length > 128)) throw new RepositoryImportError("The Codeberg branch name is invalid.", 400);
    return { provider, repository: `${owner}/${repo}`, ref: refName, refType, folder: subfolder.length ? `${subfolder.join("/")}/` : "" };
  }
  throw new RepositoryImportError("Use a repository link, /releases/tag/TAG, a pinned GitHub tree, or a Codeberg /src/commit/SHA or /src/branch/NAME game folder link.", 400);
}
function safePathSegment(value: string) {
  return Boolean(value && value !== "." && value !== ".." && !/[\\%:\u0000-\u001f\u007f]/.test(value));
}
export function isPublicV4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
/** Pin a public IPv4 address to the TLS connection. Provider wrappers below
 * keep separate exact host/path allowlists; redirects and ambient credentials
 * are never followed. */
function createPinnedReader(
  provider: string,
  allow: (url: URL) => boolean,
  accept: string,
  resolveHost = lookup,
  openRequest = request,
): ReadBytes {
  return async (rawUrl, limit, signal) => {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new RepositoryImportError("Unsafe repository download destination.", 400); }
  if (url.protocol !== "https:" || !allow(url) || url.port || url.username || url.password) {
    throw new RepositoryImportError("Unsafe repository download destination.", 400);
  }
  signal.throwIfAborted();
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new RepositoryImportError(`Public ${provider} DNS lookup timed out.`, 504));
    }, 3_000);
    signal.addEventListener("abort", abort, { once: true });
    resolveHost(url.hostname, { all: true, family: 4 }).then(
      rows => { cleanup(); resolve(rows); },
      error => { cleanup(); reject(error); },
    );
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(row => !isPublicV4(row.address))) {
    throw new RepositoryImportError(`${provider} resolved to an unsafe or unavailable public address.`, 502);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const req = openRequest(url, {
      signal, method: "GET", agent: false,
      headers: { "User-Agent": "ArenaForge-Repository-Import", Accept: accept, "Accept-Encoding": "identity", ...(provider === "GitHub" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) },
      lookup: (_hostname: string, options: any, callback: any) => {
        const address = addresses[0].address;
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        const status = response.statusCode;
        reject(new RepositoryImportError(status === 403 || status === 429
          ? `${provider}'s public request limit was reached. Try again later; no provider key is required.`
          : status === 404 ? "The public repository, revision or file was not found."
          : `${provider} refused the download (HTTP ${status}); redirects are not followed.`, status === 404 ? 404 : 502));
        return;
      }
      if ((response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") ||
          Number(response.headers["content-length"] ?? 0) > limit) {
        response.destroy();
        reject(new RepositoryImportError("The repository response exceeds its size limit or uses unsupported compression.", 413));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) {
          response.destroy(new RepositoryImportError("Repository downloads exceeded their size limit.", 413));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks, length)));
      response.on("error", reject);
    });
    req.setTimeout(12_000, () => req.destroy(new RepositoryImportError(`${provider} download timed out.`, 504)));
    req.on("error", reject);
    req.end();
  });
  };
}
export function createGithubReader(resolveHost = lookup, openRequest = request): ReadBytes {
  return createPinnedReader("GitHub",
    url => ["api.github.com", "raw.githubusercontent.com"].includes(url.hostname),
    "application/vnd.github+json", resolveHost, openRequest);
}
export function createCodebergReader(resolveHost = lookup, openRequest = request): ReadBytes {
  return createPinnedReader("Codeberg",
    url => url.hostname === "codeberg.org" && url.pathname.startsWith("/api/v1/repos/"),
    "application/json", resolveHost, openRequest);
}
export function createSourceForgeReader(resolveHost = lookup, openRequest = request): ReadBytes {
  return createPinnedReader("SourceForge",
    url => url.hostname === "sourceforge.net" && /^\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/rss$/.test(url.pathname),
    "application/rss+xml, application/xml, text/xml", resolveHost, openRequest);
}
export const safeGithubBytes = createGithubReader();
export const safeCodebergBytes = createCodebergReader();
export const safeSourceForgeBytes = createSourceForgeReader();

function blobSha(bytes: Buffer) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const readerFor = (provider: RepositoryProvider) => provider === "codeberg" ? safeCodebergBytes : safeGithubBytes;
const apiRootFor = (provider: RepositoryProvider, repository: string) =>
  provider === "codeberg" ? `https://codeberg.org/api/v1/repos/${repository}` : `https://api.github.com/repos/${repository}`;

export async function resolveRepositoryTree(value: string, signal: AbortSignal, readOverride?: ReadBytes, allowReleaseFallback = false) {
  const link = parseRepositoryLink(value);
  const read = readOverride ?? readerFor(link.provider);
  const api = apiRootFor(link.provider, link.repository);
  const json = async (path: string, limit = 512 * 1024) => {
    try { return JSON.parse((await read(`${api}${path}`, limit, signal)).toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new RepositoryImportError(`${link.provider} returned invalid repository metadata.`, 502);
      throw error;
    }
  };
  const repo = await json("");
  if (repo.private !== false || repo.disabled === true || repo.archived === true) {
    throw new RepositoryImportError(`Only public, enabled ${link.provider} repositories can be imported.`);
  }
  const reference = link.ref ?? repo.default_branch;
  if (typeof reference !== "string" || reference.length > 256) throw new RepositoryImportError("The repository has no usable default revision.");
  let commitReference = reference;
  if (link.refType === "tag") {
    let object = (await json(`/git/ref/tags/${encodeURIComponent(reference)}`)).object;
    for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
      if (!sha.test(object.sha ?? "")) throw new RepositoryImportError("Invalid release tag object.", 502);
      object = (await json(`/git/tags/${object.sha}`)).object;
    }
    if (object?.type !== "commit" || !sha.test(object.sha ?? "")) throw new RepositoryImportError("The release tag does not resolve to a bounded immutable commit.", 422);
    commitReference = object.sha;
  } else if (link.provider === "codeberg" && link.refType !== "commit") {
    const branch = await json(`/branches/${encodeURIComponent(reference)}`);
    if (!sha.test(branch.commit?.id ?? "")) throw new RepositoryImportError("Codeberg did not resolve this branch to an immutable commit.", 502);
    commitReference = branch.commit.id;
  }
  const commit = link.provider === "github"
    ? await json(`/commits/${encodeURIComponent(commitReference)}`)
    : await json(`/git/commits/${encodeURIComponent(commitReference)}`);
  const revisionValue = commit.sha ?? commit.id;
  if (!sha.test(revisionValue ?? "") || (link.refType === "commit" && revisionValue !== link.ref)) {
    throw new RepositoryImportError(`${link.provider} did not resolve this link to the requested immutable commit.`, 502);
  }
  const revision = revisionValue as string;
  let tree, sourceComplete = true;
  try {
    tree = await json(`/git/trees/${revision}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 2000) throw new RepositoryImportError("This repository tree is too large.", 422);
    if (tree.tree.some((node: RepositoryNode) => typeof node.path !== "string" || !node.path.split("/").every(safePathSegment))) {
      throw new RepositoryImportError("The repository contains unsafe file paths.", 422);
    }
  } catch (error) {
    if (!allowReleaseFallback || !(error instanceof RepositoryImportError) || ![413, 422].includes(error.status)) throw error;
    tree = await json(`/git/trees/${revision}`);
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 2000) throw new RepositoryImportError("Root source metadata is too large to review safely.", 422);
    tree.tree = tree.tree.filter((node: RepositoryNode) => typeof node.path === "string" && !node.path.includes("/") && safePathSegment(node.path));
    sourceComplete = false;
  }
  const nodes: RepositoryNode[] = tree.tree;
  if (nodes.some(node => typeof node.path !== "string" || !node.path.split("/").every(safePathSegment))) {
    throw new RepositoryImportError("The repository contains unsafe file paths.");
  }
  return { link, reference, revision, nodes, json, metadata: repo, sourceComplete };
}

function detectFullLicense(text: string) {
  const value = text.replace(/\r/g, "");
  if (/Permission is hereby granted, free of charge[\s\S]{0,2000}THE SOFTWARE IS PROVIDED ["“]AS IS["”]/i.test(value)) return "MIT";
  if (/Apache License[\s\S]{0,200}Version 2\.0/i.test(value) && /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i.test(value)) return "Apache-2.0";
  if (/GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,120}Version 3/i.test(value) &&
      /TERMS AND CONDITIONS/i.test(value) &&
      /13\.\s+Remote Network Interaction; Use with the GNU General Public License/i.test(value) &&
      /14\.\s+Revised Versions of this License/i.test(value) &&
      /END OF TERMS AND CONDITIONS/i.test(value)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,120}Version 3/i.test(value) && /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/i.test(value)) return "LGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,120}Version 2\.1/i.test(value) && /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/i.test(value)) return "LGPL-2.1";
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,120}Version 3/i.test(value) && /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/i.test(value)) return "GPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,120}Version 2/i.test(value) && /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/i.test(value)) return "GPL-2.0";
  if (/Mozilla Public License[\s\S]{0,100}Version 2\.0/i.test(value) && /Exhibit A - Source Code Form License/i.test(value)) return "MPL-2.0";
  if (/Redistribution and use in source and binary forms, with or without modification/i.test(value) &&
      /THE SOFTWARE IS PROVIDED ["“]AS IS["”]/i.test(value)) {
    return /Neither the name of the .* nor the names of its contributors may be used/i.test(value) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(value) &&
      /THE SOFTWARE IS PROVIDED ["“]AS IS["”]/i.test(value)) return "ISC";
  if (/This software is provided ["'“]as-is["'”]/i.test(value)) return "Zlib";
  if (/Creative Commons Zero v1\.0 Universal/i.test(value) && /No Copyright/i.test(value)) return "CC0-1.0";
  if (/This is free and unencumbered software released into the public domain/i.test(value)) return "Unlicense";
  return null;
}

export async function readRepositoryLicense(
  snapshot: Awaited<ReturnType<typeof resolveRepositoryTree>>,
  signal: AbortSignal = AbortSignal.timeout(15_000),
  readOverride?: ReadBytes,
) {
  const { json, revision, nodes } = snapshot;
  const read = readOverride ?? readerFor(snapshot.link.provider);
  if (snapshot.link.provider === "codeberg") {
    const candidates = nodes.filter(node => node.type === "blob" && !node.path.includes("/") &&
      /^(?:license|copying)(?:\.(?:txt|md|rst))?$/i.test(node.path));
    for (const node of candidates.slice(0, 4)) {
      if (!Number.isSafeInteger(node.size) || node.size <= 0 || node.size > 128 * 1024) continue;
      const bytes = await readRepositoryFile(snapshot.link.repository, revision,
        { path: node.path, size: node.size, sha: node.sha }, signal, read, "codeberg");
      const text = bytes.toString("utf8");
      const spdx = detectFullLicense(text);
      if (spdx && licenses.has(spdx)) return { spdx, path: node.path, text };
    }
    throw new RepositoryImportError("No supported full license text could be verified against the pinned Codeberg tree. A catalog label is not enough to import source.");
  }
  let licenseData;
  try { licenseData = await json(`/license?ref=${revision}`, 256 * 1024); }
  catch (error) {
    if (error instanceof RepositoryImportError && error.status === 404) {
      throw new RepositoryImportError("No verifiable open-source license was found at this revision. A public repository alone is not permission to import it.");
    }
    throw error;
  }
  const spdx = licenseData.license?.spdx_id;
  const licensePath = licenseData.path;
  if (!licenses.has(spdx) || typeof licensePath !== "string" || licenseData.encoding !== "base64" ||
      typeof licenseData.content !== "string" || licenseData.content.length > 180_000) {
    throw new RepositoryImportError("An explicitly supported open-source license is required. Missing, custom and unrecognized licenses are not automatically authorized.");
  }
  const licenseBytes = Buffer.from(licenseData.content, "base64");
  const licenseNode = nodes.find(node => node.path === licensePath);
  if (!licenseBytes.length || licenseBytes.length > 128 * 1024 || !licenseNode || licenseNode.sha !== blobSha(licenseBytes)) {
    throw new RepositoryImportError("The license file could not be verified against the pinned source tree.");
  }
  return { spdx: spdx as string, path: licensePath as string, text: licenseBytes.toString("utf8") };
}

export async function readRepositoryWorkStateWarning(
  snapshot: Awaited<ReturnType<typeof resolveRepositoryTree>>,
  signal: AbortSignal,
  readOverride?: ReadBytes,
) {
  if (snapshot.link.provider !== "codeberg") return null;
  const node = snapshot.nodes.find(candidate => candidate.type === "blob" &&
    !candidate.path.includes("/") && /^readme\.md$/i.test(candidate.path));
  if (!node || !Number.isSafeInteger(node.size) || node.size <= 0 || node.size > 128 * 1024) return null;
  const bytes = await readRepositoryFile(snapshot.link.repository, snapshot.revision,
    { path: node.path, size: node.size, sha: node.sha }, signal, readOverride, "codeberg");
  const text = bytes.toString("utf8");
  if (!/curr(?:ently|ntly)\s+not\s+in\s+a\s+working\s+state/i.test(text)) return null;
  return {
    path: node.path,
    message: "The pinned upstream README explicitly says this repository is not in a working state; source import is blocked.",
    detail: "Pinned README warns that this repository is currently not in a working state.",
  };
}

export async function readRepositoryFile(
  repository: string,
  revision: string,
  file: RepositoryFile,
  signal: AbortSignal,
  readOverride?: ReadBytes,
  provider: RepositoryProvider = "github",
) {
  if (!sha.test(revision) || !file.path.split("/").every(safePathSegment) || !Number.isSafeInteger(file.size) || file.size < 0 || !sha.test(file.sha)) {
    throw new RepositoryImportError("Invalid pinned repository file.");
  }
  const encoded = file.path.split("/").map(encodeURIComponent).join("/");
  let bytes: Buffer;
  if (provider === "codeberg") {
    const read = readOverride ?? safeCodebergBytes;
    const url = `https://codeberg.org/api/v1/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(revision)}`;
    let data: any;
    try { data = JSON.parse((await read(url, Math.min(3 * 1024 * 1024, Math.ceil(file.size * 1.5) + 2048), signal)).toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new RepositoryImportError("Codeberg returned invalid pinned file metadata.", 502);
      throw error;
    }
    if (data.type !== "file" || data.path !== file.path || data.encoding !== "base64" || data.sha !== file.sha ||
        typeof data.content !== "string" || data.content.length > 2 * 1024 * 1024) {
      throw new RepositoryImportError(`Codeberg did not return the reviewed pinned file: ${file.path}.`);
    }
    bytes = Buffer.from(data.content.replace(/\s/g, ""), "base64");
  } else {
    const read = readOverride ?? safeGithubBytes;
    bytes = await read(`https://raw.githubusercontent.com/${repository}/${revision}/${encoded}`, file.size, signal);
  }
  if (bytes.length !== file.size || blobSha(bytes) !== file.sha) throw new RepositoryImportError(`Pinned file verification failed: ${file.path}.`);
  if (bytes.subarray(0, 100).toString().startsWith("version https://git-lfs.github.com/spec/")) throw new RepositoryImportError(`Git LFS files are not supported: ${file.path}.`);
  return bytes;
}

export async function inspectRepository(value: string, signal: AbortSignal, read?: ReadBytes): Promise<RepositoryPlan> {
  const snapshot = await resolveRepositoryTree(value, signal, read);
  const { link, revision, reference, nodes } = snapshot;
  const pages = nodes.filter(node => node.type === "blob" && node.path.startsWith(link.folder) && /\.html?$/i.test(node.path));
  const indexPage = pages.find(node => node.path === `${link.folder}index.html`);
  if (!indexPage && pages.length !== 1) throw new RepositoryImportError(pages.length
    ? `Found ${pages.length} HTML pages. Use a pinned /tree/${revision}/game-folder link containing exactly one game page.`
    : "No ready-to-play HTML page was found. This importer does not run build scripts; provide an offline HTML game or built game folder.");
  const entryPath = (indexPage ?? pages[0]).path;
  const gameFolder = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
  const license = await readRepositoryLicense(snapshot, signal, read);
  const workStateWarning = await readRepositoryWorkStateWarning(snapshot, signal, read);
  if (workStateWarning) throw new RepositoryImportError(workStateWarning.message, 422);
  const licensePath = license.path;
  const selected = nodes.filter(node => node.path === licensePath ||
    (node.path.startsWith(gameFolder) && node.type !== "tree" && supportedFile.test(node.path) &&
      (!/\.html?$/i.test(node.path) || node.path === entryPath)));
  if (selected.some(node => node.mode !== "100644" && node.mode !== "100755") ||
      nodes.some(node => node.path.startsWith(gameFolder) && ["120000", "160000"].includes(node.mode))) {
    throw new RepositoryImportError("Symbolic links and submodules are not supported in game packages.");
  }
  const files = selected.map(node => ({ path: node.path, size: node.size, sha: node.sha }));
  if (!files.length || files.length > MAX_FILES || new Set(files.map(file => file.path)).size !== files.length ||
      files.some(file => !Number.isSafeInteger(file.size) || file.size < 0 || !sha.test(file.sha))) {
    throw new RepositoryImportError(`Ready-to-play packages are limited to ${MAX_FILES} regular files.`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BYTES) throw new RepositoryImportError("Repository game packages are limited to 2 MB total, before compression.", 413);
  return {
    provider: link.provider,
    repository: link.repository, revision, reference,
    sourceUrl: link.provider === "github"
      ? `https://github.com/${link.repository}/tree/${revision}`
      : `https://codeberg.org/${link.repository}/src/commit/${revision}`,
    entryPath, files, totalBytes,
    license,
  };
}

export async function acquireRepository(plan: RepositoryPlan, signal: AbortSignal, read?: ReadBytes) {
  const files: Array<RepositoryFile & { contentBase64: string }> = [];
  // Small sequential batches bound both network concurrency and transient bytes.
  for (let offset = 0; offset < plan.files.length; offset += 4) {
    const batch = await Promise.all(plan.files.slice(offset, offset + 4).map(async file => {
      const bytes = await readRepositoryFile(plan.repository, plan.revision, file, signal, read,
        plan.provider ?? (plan.sourceUrl.includes("codeberg.org") ? "codeberg" : "github"));
      return { ...file, contentBase64: bytes.toString("base64") };
    }));
    files.push(...batch);
  }
  const { repository, revision, sourceUrl, license } = plan;
  return { provenance: { repository, revision, sourceUrl, license }, files };
}

const previews = new Map<string, { owner: string; expiresAt: number; plan: RepositoryPlan }>();
export function rememberRepositoryPlan(owner: string, plan: RepositoryPlan) {
  for (const [token, entry] of previews) if (entry.expiresAt <= Date.now()) previews.delete(token);
  for (const [token, entry] of previews) if (entry.owner === owner) previews.delete(token);
  if (previews.size >= 16) throw new RepositoryImportError("Repository previews are busy. Try again shortly.", 429);
  const token = randomUUID(), expiresAt = Date.now() + TTL_MS;
  previews.set(token, { owner, expiresAt, plan });
  return { token, expiresAt, ...plan };
}
export function recalledRepositoryPlan(owner: string, token: string) {
  const entry = previews.get(token);
  if (!entry || entry.owner !== owner || entry.expiresAt <= Date.now()) {
    throw new RepositoryImportError("This repository preview expired or belongs to another session. Inspect the link again.", 409);
  }
  return entry.plan;
}
