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
export type RepositoryPlan = RepositoryProvenance & {
  entryPath: string; files: RepositoryFile[]; totalBytes: number; reference: string;
};
type ReadBytes = (url: string, limit: number, signal: AbortSignal) => Promise<Buffer>;

export function parseRepositoryLink(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RepositoryImportError("Enter a complete HTTPS GitHub repository or release-tag link.", 400); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
    throw new RepositoryImportError("Only public https://github.com repository, pinned tree, and release-tag links are supported. Queries, credentials and other hosts are not allowed.", 400);
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  const [owner, rawRepo, kind, ref, ...folder] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner ?? "") ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo ?? "") || repo === "." || repo === "..") {
    throw new RepositoryImportError("The GitHub owner or repository name is invalid.", 400);
  }
  if (parts.length === 2) return { repository: `${owner}/${repo}`, ref: null, folder: "" };
  if (kind === "releases" && ref === "tag" && folder.length === 1 && /^[A-Za-z0-9_.-]{1,128}$/.test(folder[0])) {
    return { repository: `${owner}/${repo}`, ref: folder[0], folder: "" };
  }
  if (kind === "tree" && sha.test(ref ?? "") && folder.every(safePathSegment)) {
    return { repository: `${owner}/${repo}`, ref, folder: folder.length ? `${folder.join("/")}/` : "" };
  }
  throw new RepositoryImportError("Use a repository link, /releases/tag/TAG, or /tree/40-character-commit/optional-game-folder. Binary release downloads and build-only projects are not supported.", 400);
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
/** Fixed GitHub hosts only; pin a validated address to the TLS connection.
 * No redirects, ambient credentials, proxy URLs, decompression or repo scripts. */
export function createGithubReader(resolveHost = lookup, openRequest = request): ReadBytes {
  return async (rawUrl, limit, signal) => {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !["api.github.com", "raw.githubusercontent.com"].includes(url.hostname) ||
      url.port || url.username || url.password) throw new RepositoryImportError("Unsafe repository download destination.", 400);
  signal.throwIfAborted();
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new RepositoryImportError("Public GitHub DNS lookup timed out.", 504));
    }, 3_000);
    signal.addEventListener("abort", abort, { once: true });
    resolveHost(url.hostname, { all: true, family: 4 }).then(
      rows => { cleanup(); resolve(rows); },
      error => { cleanup(); reject(error); },
    );
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(row => !isPublicV4(row.address))) {
    throw new RepositoryImportError("GitHub resolved to an unsafe or unavailable public address.", 502);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const req = openRequest(url, {
      signal, method: "GET", agent: false,
      headers: { "User-Agent": "ArenaForge-Repository-Import", Accept: "application/vnd.github+json", "Accept-Encoding": "identity", "X-GitHub-Api-Version": "2022-11-28" },
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
          ? "GitHub's public request limit was reached. Try again later; no provider key is required."
          : status === 404 ? "The public repository, revision or file was not found."
          : `GitHub refused the download (HTTP ${status}); redirects are not followed.`, status === 404 ? 404 : 502));
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
    req.setTimeout(12_000, () => req.destroy(new RepositoryImportError("GitHub download timed out.", 504)));
    req.on("error", reject);
    req.end();
  });
  };
}
export const safeGithubBytes = createGithubReader();

function blobSha(bytes: Buffer) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export async function inspectRepository(value: string, signal: AbortSignal, read: ReadBytes = safeGithubBytes): Promise<RepositoryPlan> {
  const link = parseRepositoryLink(value);
  const api = `https://api.github.com/repos/${link.repository}`;
  const json = async (path: string, limit = 512 * 1024) => {
    try { return JSON.parse((await read(`${api}${path}`, limit, signal)).toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new RepositoryImportError("GitHub returned invalid repository metadata.", 502);
      throw error;
    }
  };
  const repo = await json("");
  if (repo.private !== false || repo.disabled === true) throw new RepositoryImportError("Only public, enabled GitHub repositories can be imported.");
  const reference = link.ref ?? repo.default_branch;
  if (typeof reference !== "string" || reference.length > 256) throw new RepositoryImportError("The repository has no usable default revision.");
  const commit = await json(`/commits/${encodeURIComponent(reference)}`);
  if (!sha.test(commit.sha ?? "")) throw new RepositoryImportError("GitHub did not resolve this link to an immutable commit.", 502);
  const revision = commit.sha as string;
  const tree = await json(`/git/trees/${revision}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 2000) {
    throw new RepositoryImportError("This repository tree is too large. Import a small, already-built offline game package instead.");
  }
  const nodes: Array<{ path: string; mode: string; type: string; size: number; sha: string }> = tree.tree;
  if (nodes.some(node => typeof node.path !== "string" || !node.path.split("/").every(safePathSegment))) {
    throw new RepositoryImportError("The repository contains unsafe file paths.");
  }
  const pages = nodes.filter(node => node.type === "blob" && node.path.startsWith(link.folder) && /\.html?$/i.test(node.path));
  const indexPage = pages.find(node => node.path === `${link.folder}index.html`);
  if (!indexPage && pages.length !== 1) throw new RepositoryImportError(pages.length
    ? `Found ${pages.length} HTML pages. Use a pinned /tree/${revision}/game-folder link containing exactly one game page.`
    : "No ready-to-play HTML page was found. This importer does not run build scripts; provide an offline HTML game or built game folder.");
  const entryPath = (indexPage ?? pages[0]).path;
  const gameFolder = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
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
    repository: link.repository, revision, reference,
    sourceUrl: `https://github.com/${link.repository}/tree/${revision}`,
    entryPath, files, totalBytes,
    license: { spdx, path: licensePath, text: licenseBytes.toString("utf8") },
  };
}

export async function acquireRepository(plan: RepositoryPlan, signal: AbortSignal, read: ReadBytes = safeGithubBytes) {
  const files: Array<RepositoryFile & { contentBase64: string }> = [];
  // Small sequential batches bound both network concurrency and transient bytes.
  for (let offset = 0; offset < plan.files.length; offset += 4) {
    const batch = await Promise.all(plan.files.slice(offset, offset + 4).map(async file => {
      const path = file.path.split("/").map(encodeURIComponent).join("/");
      const bytes = await read(`https://raw.githubusercontent.com/${plan.repository}/${plan.revision}/${path}`, file.size, signal);
      if (bytes.length !== file.size || blobSha(bytes) !== file.sha) throw new RepositoryImportError(`Pinned file verification failed: ${file.path}.`);
      if (bytes.subarray(0, 100).toString().startsWith("version https://git-lfs.github.com/spec/")) {
        throw new RepositoryImportError(`Git LFS files are not supported: ${file.path}.`);
      }
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
