import { createHash, randomUUID } from "node:crypto";
import {
  RepositoryImportError, readRepositoryFile, readRepositoryLicense, readRepositoryWorkStateWarning, resolveRepositoryTree, safeCodebergBytes,
  safeGithubBytes, safeSourceForgeBytes, type ReadBytes, type RepositoryFile, type RepositoryProvenance,
} from "./repository-source";

const SOURCE_LIMIT = 16 * 1024 * 1024;
const SOURCE_FILES = 256;
type Evidence = { path: string; detail: string };
export type RepositoryAssessment = {
  provider: string; repository: string; revision: string; reference: string; sourceUrl: string; folder: string;
  projectType: "browser" | "godot" | "sdl" | "native" | "unknown";
  confidence: "high" | "medium" | "low";
  languages: string[]; buildSystems: string[]; dependencies: string[]; sdks: string[];
  targets: string[]; modHooks: string[]; evidence: Evidence[]; blockers: string[];
  license: RepositoryProvenance["license"] | null;
  files: RepositoryFile[]; totalBytes: number; releases: RepositoryRelease[];
};
export type RepositoryRelease = {
  name: string; tag: string; reviewUrl: string; prerelease: boolean;
  assets: Array<{ name: string; url: string; bytes: number; sha256: string | null }>;
};
/** Provider interface is intentionally read-only. Adding another provider does
 * not grant arbitrary URL fetching or host execution to repository content. */
export interface RepositoryAssessmentProvider {
  id: string;
  accepts(url: URL): boolean;
  assess(url: string, signal: AbortSignal): Promise<RepositoryAssessment>;
}

export async function assessGithubRepository(value: string, signal: AbortSignal, read: ReadBytes = safeGithubBytes): Promise<RepositoryAssessment> {
  const snapshot = await resolveRepositoryTree(value, signal, read, true);
  const { link, revision, nodes, json } = snapshot;
  if (link.provider !== "github") throw new RepositoryImportError("The GitHub reviewer cannot assess a different provider.", 400);
  return assessPinnedSource(snapshot, value, signal, read);
}

async function assessPinnedSource(
  snapshot: Awaited<ReturnType<typeof resolveRepositoryTree>>,
  value: string,
  signal: AbortSignal,
  read: ReadBytes,
): Promise<RepositoryAssessment> {
  const { link, revision, nodes, json } = snapshot;
  const blockers: string[] = [], evidence: Evidence[] = [];
  if (!snapshot.sourceComplete) {
    blockers.push("Full source inspection exceeds the bounded importer or includes unsupported paths. Only root metadata was reviewed; source acquisition is disabled. A pinned portable release may still be reviewed.");
    evidence.push({ path: "/", detail: "Release-only root metadata review; displayed files and bytes are not the full repository." });
  }
  const inFolder = nodes.filter(node => node.path.startsWith(link.folder) && node.type !== "tree");
  const files = inFolder.filter(node => node.type === "blob").map(({ path, size, sha }) => ({ path, size, sha }));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{40}$/.test(file.sha))) {
    throw new RepositoryImportError("The repository has invalid file metadata.", 502);
  }
  if (inFolder.some(node => !["100644", "100755"].includes(node.mode))) blockers.push("Source contains a symbolic link or submodule. Supply a self-contained project.");
  if (files.length > SOURCE_FILES || totalBytes > SOURCE_LIMIT) blockers.push("Source acquisition is limited to 256 files and 16 MiB. Choose a pinned, self-contained game folder.");
  const find = (name: string) => files.find(file => file.path === `${link.folder}${name}`);
  const text = async (file: RepositoryFile | undefined) => {
    if (!file || file.size > 128 * 1024) return "";
    return (await readRepositoryFile(link.repository, revision, file, signal, read, link.provider)).toString("utf8");
  };
  const workStateWarning = await readRepositoryWorkStateWarning(snapshot, signal, read);
  if (workStateWarning) {
    blockers.push(workStateWarning.message);
    evidence.push({ path: workStateWarning.path, detail: workStateWarning.detail });
  }
  let license: RepositoryAssessment["license"] = null;
  try { license = await readRepositoryLicense(snapshot, signal, read); }
  catch (error) {
    if (!(error instanceof RepositoryImportError) || ![404, 422].includes(error.status)) throw error;
    blockers.push(error.message);
  }
  const languages = new Set<string>(), buildSystems: string[] = [], dependencies: string[] = [], sdks: string[] = [];
  const extensions: Record<string, string> = { gd: "GDScript", cs: "C#", c: "C", cpp: "C++", cc: "C++", js: "JavaScript", ts: "TypeScript", html: "HTML", htm: "HTML" };
  for (const file of files) {
    const language = extensions[file.path.split(".").pop()?.toLowerCase() ?? ""];
    if (language) languages.add(language);
  }
  let projectType: RepositoryAssessment["projectType"] = "unknown", confidence: RepositoryAssessment["confidence"] = "low";
  const targets: string[] = [], modHooks: string[] = [];
  const project = find("project.godot"), cmake = find("CMakeLists.txt"), browser = find("index.html");
  if (project) {
    projectType = "godot"; confidence = "medium";
    const config = await text(project);
    evidence.push({ path: project.path, detail: "Godot project configuration exists; no engine has been executed." });
    buildSystems.push("Godot resource import and pack export");
    const major = /config_version\s*=\s*(\d+)/.exec(config)?.[1];
    sdks.push(major === "5" ? "Godot 4 standard editor, exact version pinned before building" : "Matching Godot editor version must be determined");
    if (major !== "5") blockers.push("Only Godot 4 standard (non-.NET) projects have a planned build recipe.");
    if (languages.has("C#") || files.some(file => /\.(?:gdextension|gdnlib|gdns)$/i.test(file.path))) blockers.push("This Godot project requires .NET or native extensions; the standard editor recipe cannot build it.");
    const scene = /run\/main_scene\s*=\s*"res:\/\/([^"]+)"/.exec(config)?.[1];
    if (scene && find(scene)) {
      confidence = "high"; evidence.push({ path: `${link.folder}${scene}`, detail: "Configured main scene is present in the pinned tree." });
    } else if (/run\/main_scene\s*=\s*"uid:\/\/[a-z0-9]+"/.test(config) && files.some(file => file.path.endsWith(".tscn"))) {
      evidence.push({ path: project.path, detail: "Main scene uses a Godot UID. The isolated resource import must resolve it before export; its mapping is not statically verified." });
    } else blockers.push("No main scene could be identified. Editor tools and scene-less projects need a separate review.");
    const exports = await text(find("export_presets.cfg"));
    for (const match of exports.matchAll(/^platform="([^"\r\n]{1,100})"/gm)) if (!targets.includes(match[1])) targets.push(match[1]);
    if (!targets.length) targets.push("No export target declared");
    if (files.some(file => file.path.startsWith(`${link.folder}addons/`))) {
      dependencies.push("Editor addons included in source; importing may execute their tool scripts inside isolation.");
      evidence.push({ path: `${link.folder}addons/`, detail: "Addon directory exists; this does not prove a supported mod API." });
    }
  } else if (cmake || find("main.c") || find("main.cpp")) {
    const build = await text(cmake);
    const main = find("main.c") ?? find("main.cpp");
    const code = await text(main);
    if (/\bSDL(?:2)?\b|SDL\.h/.test(`${build}\n${code}`)) {
      projectType = "sdl"; confidence = "medium"; dependencies.push("SDL2 development headers, import library and matching runtime DLL");
      sdks.push("Pinned Windows C/C++ cross-toolchain and target sysroot");
      buildSystems.push(cmake ? "CMake detected; repository CMake scripts are not executed" : "Direct compiler recipe candidate");
      evidence.push({ path: cmake?.path ?? main!.path, detail: "SDL dependency detected; this is not gameplay verification." });
      if (main && /SDL_(?:PollEvent|WaitEvent)/.test(code) && /SDL_(?:RenderPresent|UpdateWindowSurface|GL_SwapWindow)/.test(code)) {
        confidence = "high"; evidence.push({ path: main.path, detail: "Source contains SDL event handling and presentation calls." });
      }
      if (!find("main.c") || files.filter(file => /\.(?:c|cpp|cc|cxx)$/i.test(file.path)).length !== 1) blockers.push("The bounded SDL build recipe supports one root main.c, local headers and assets. Multi-unit/C++ layouts need another recipe; CMake scripts are not executed.");
      targets.push("Windows x64 recipe candidate");
    }
  }
  if (projectType === "unknown" && browser) {
    projectType = "browser"; confidence = "medium"; targets.push("Offline browser");
    buildSystems.push("Existing bounded offline HTML importer");
    evidence.push({ path: browser.path, detail: "Root HTML entry exists. Offline assets, scripts and startup still require the browser import checks." });
  }
  if (projectType === "unknown" && (cmake || find("Makefile") || find("Cargo.toml") || find("configure.ac"))) {
    projectType = "native";
    const marker = cmake ?? find("Makefile") ?? find("Cargo.toml") ?? find("configure.ac")!;
    buildSystems.push("Native build manifest detected; repository scripts are not executed");
    evidence.push({ path: marker.path, detail: "Native project metadata, not proof of a game, executable or supported source build." });
    blockers.push("This native project has no approved source build recipe. Review a Windows x64 portable release instead, when available.");
    targets.push("Windows x64 portable release, if published");
  }
  if (find("package.json")) {
    buildSystems.push("package.json detected; npm install and package scripts are not run");
    dependencies.push("JavaScript dependency manifest requires an offline built bundle or a separately approved recipe");
  }
  if (projectType === "unknown") blockers.push("No supported game entry was identified. Public source and a README do not establish a runnable game.");
  if (files.some(file => file.path.endsWith(".pck"))) evidence.push({ path: files.find(file => file.path.endsWith(".pck"))!.path, detail: "Godot pack present; no advertised mod hooks are inferred from it." });
  // Absence is deliberate: script files or an addons folder are not a mod API.
  const releases: RepositoryRelease[] = [];
  const rawReleases = await json(link.provider === "github" ? "/releases?per_page=3" : "/releases?limit=3", 256 * 1024);
  if (!Array.isArray(rawReleases)) throw new RepositoryImportError("Invalid release metadata.", 502);
  const releaseCandidates = rawReleases.slice(0, 3);
  if (value.includes("/releases/tag/") && !releaseCandidates.some(release => release.tag_name === link.ref)) {
    releaseCandidates.unshift(await json(`/releases/tags/${encodeURIComponent(link.ref!)}`, 256 * 1024));
  }
  for (const release of releaseCandidates.slice(0, 4)) {
    if (release.draft || typeof release.tag_name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(release.tag_name)) continue;
    const tag = release.tag_name;
    const assets: RepositoryRelease["assets"] = [];
    for (const asset of (Array.isArray(release.assets) ? release.assets : []).slice(0, 24)) {
      if (typeof asset.name !== "string" || asset.name.length > 200 || /[\\/\u0000-\u001f]/.test(asset.name) ||
          !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
      const host = link.provider === "github" ? "github.com" : "codeberg.org";
      const expected = `https://${host}/${link.repository}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
      if (asset.browser_download_url !== expected) continue;
      assets.push({ name: asset.name, url: expected, bytes: asset.size, sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ? asset.digest.slice(7) : null });
    }
    releases.push({ name: typeof release.name === "string" ? release.name.slice(0, 200) : tag, tag,
      reviewUrl: `https://${link.provider === "github" ? "github.com" : "codeberg.org"}/${link.repository}/releases/tag/${tag}`,
      prerelease: release.prerelease === true, assets });
  }
  return { provider: link.provider, repository: link.repository, revision, reference: snapshot.reference, folder: link.folder,
    sourceUrl: link.provider === "github"
      ? `https://github.com/${link.repository}/tree/${revision}`
      : `https://codeberg.org/${link.repository}/src/commit/${revision}`,
    projectType, confidence, languages: [...languages],
    buildSystems, dependencies, sdks, targets, modHooks, evidence, blockers, license, files, totalBytes, releases };
}

export async function assessCodebergRepository(value: string, signal: AbortSignal, read: ReadBytes = safeCodebergBytes) {
  const snapshot = await resolveRepositoryTree(value, signal, read, true);
  if (snapshot.link.provider !== "codeberg") throw new RepositoryImportError("The Codeberg reviewer cannot assess a different provider.", 400);
  return assessPinnedSource(snapshot, value, signal, read);
}

function sourceForgeText(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const number = code[0]?.toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    });
}

function sourceForgeLink(value: string) {
  if (/%(?:2e|2f|5c)/i.test(value) || /\/(?:\.{1,2})(?:\/|[?#]|$)/.test(value)) {
    throw new RepositoryImportError("Encoded separators and dot-path traversal are not supported.", 400);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new RepositoryImportError("Enter a SourceForge project or files link.", 400); }
  if (url.protocol !== "https:" || url.hostname !== "sourceforge.net" || url.port || url.username || url.password || url.search || url.hash) {
    throw new RepositoryImportError("Only public sourceforge.net project and files links are supported.", 400);
  }
  const parts = url.pathname.split("/").filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return ""; }
  });
  if (parts[0] !== "projects" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(parts[1] ?? "")) {
    throw new RepositoryImportError("Use https://sourceforge.net/projects/PROJECT or a project files link.", 400);
  }
  const project = parts[1].toLowerCase();
  let folder: string[] = [];
  if (parts.length > 2) {
    if (parts[2] !== "files" || parts.length > 14 || !parts.slice(3).every(part =>
      part && part !== "." && part !== ".." && !/[\\%:\u0000-\u001f\u007f]/.test(part))) {
      throw new RepositoryImportError("Only a public SourceForge project or versioned files folder can be reviewed.", 400);
    }
    folder = parts.slice(3);
  }
  return { project, folder };
}

function sourceForgeFolderFromItem(path: string, project: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === project) parts.shift();
  if (parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/.test(part))) return null;
  return parts.slice(0, -1);
}

export async function assessSourceForgeRepository(
  value: string,
  signal: AbortSignal,
  read: ReadBytes = safeSourceForgeBytes,
): Promise<RepositoryAssessment> {
  const { project, folder } = sourceForgeLink(value);
  const feedPath = folder.length ? `/${folder.join("/")}` : "/";
  const feedUrl = `https://sourceforge.net/projects/${project}/rss?path=${encodeURIComponent(feedPath)}`;
  const xml = (await read(feedUrl, 256 * 1024, signal)).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RepositoryImportError("SourceForge feeds containing DTD and entity declarations are refused.", 502);
  if (!/^(?:<\?xml[^>]*>\s*)?<rss\b/i.test(xml.trim())) throw new RepositoryImportError("SourceForge returned an unsupported feed format.", 502);
  const allRows = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 120).map(match => {
    const item = match[1];
    const tag = (name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "i").exec(item)?.[1] ?? "";
    const rawPath = sourceForgeText(tag("title")).trim();
    const linkText = sourceForgeText(tag("link")).trim();
    const id = sourceForgeText(tag("files:sf-file-id")).trim();
    const sizeText = /<media:content\b[^>]*\bfilesize=["'](\d+)["']/i.exec(item)?.[1];
    const digest = /<media:hash\b[^>]*\balgo=["']([^"']+)["'][^>]*>([^<]+)<\/media:hash>/i.exec(item);
    const pubDate = sourceForgeText(tag("pubDate")).trim();
    let link: URL | null = null;
    try { link = new URL(linkText); } catch { /* invalid item remains unselectable */ }
    if (!rawPath.startsWith("/") || !/^\d{1,20}$/.test(id) || !Number.isSafeInteger(Number(sizeText)) ||
        !link || link.protocol !== "https:" || link.hostname !== "sourceforge.net" || link.username || link.password ||
        link.port || link.hash || !link.pathname.startsWith(`/projects/${project}/files/`) || !link.pathname.endsWith("/download")) return null;
    const segments = rawPath.split("/").filter(Boolean);
    if (segments[0]?.toLowerCase() !== project || !segments.every(part => part !== "." && part !== ".." && !/[\\\u0000-\u001f\u007f]/.test(part))) return null;
    const algorithm = digest?.[1]?.toLowerCase();
    const digestValue = digest?.[2]?.trim().toLowerCase() ?? "";
    const md5 = algorithm === "md5" && /^[a-f0-9]{32}$/.test(digestValue) ? digestValue : null;
    const sha256 = algorithm === "sha256" && /^[a-f0-9]{64}$/.test(digestValue) ? digestValue : null;
    return { path: rawPath, id, size: Number(sizeText), url: link.toString(), md5, sha256, pubDate };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const requestedFolder = (folder[0]?.toLowerCase() === project ? folder.slice(1) : folder).join("/");
  const rows = requestedFolder ? allRows.filter(item =>
    sourceForgeFolderFromItem(item.path, project)?.join("/") === requestedFolder) : allRows;
  if (!rows.length) throw new RepositoryImportError("The SourceForge feed contained no safely reviewable release files.", 404);

  const releasesByPath = new Map<string, RepositoryRelease>();
  const evidence: Evidence[] = [];
  for (const row of rows) {
    const pathParts = row.path.split("/").filter(Boolean);
    const releaseFolder = sourceForgeFolderFromItem(row.path, project);
    const tag = releaseFolder?.length ? releaseFolder.join("/") : "Project files";
    let release = releasesByPath.get(tag);
    if (!release && releasesByPath.size < 12) {
      const reviewUrl = `https://sourceforge.net/projects/${project}/files/${[project, ...(releaseFolder ?? [])].map(encodeURIComponent).join("/")}`;
      release = { name: tag, tag, reviewUrl, prerelease: false, assets: [] };
      releasesByPath.set(tag, release);
    }
    if (!release || release.assets.length >= 24) continue;
    const name = pathParts.at(-1) ?? "unnamed";
    release.assets.push({ name, url: row.url, bytes: row.size, sha256: row.sha256 });
    const checksums = [row.sha256 ? `SHA-256 ${row.sha256}` : null, row.md5 ? `MD5 ${row.md5}` : null].filter(Boolean).join(" and ");
    evidence.push({ path: row.path, detail: `SourceForge RSS file #${row.id}${checksums ? ` publishes ${checksums}` : " has no publisher checksum"}${row.pubDate ? `; listed ${row.pubDate}` : ""}. This is release metadata, not a verified source tree.` });
  }
  const exactFolder = (folder[0]?.toLowerCase() === project ? folder.slice(1) : folder).join("/");
  const manifest = rows.map(row => [row.path, row.id, row.size, row.md5 ?? "", row.sha256 ?? "", row.pubDate].join("\0")).join("\n");
  const revision = `sf-rss-${createHash("sha256").update(manifest).digest("hex")}`;
  evidence.unshift({ path: `/projects/${project}/rss?path=${feedPath}`, detail: `Pinned this RSS metadata snapshot with a SHA-256 fingerprint over ${rows.length} SourceForge file IDs. It does not checksum the files themselves.` });
  return {
    provider: "sourceforge", repository: `sourceforge/${project}`, revision,
    reference: exactFolder || revision,
    sourceUrl: `https://sourceforge.net/projects/${project}/files/${folder.map(encodeURIComponent).join("/")}`,
    folder: exactFolder, projectType: "unknown", confidence: "low",
    languages: [], buildSystems: ["SourceForge release-feed metadata only"], dependencies: [], sdks: [], targets: [], modHooks: [],
    evidence: evidence.slice(0, 48),
    blockers: [
      "This catalog link identifies SourceForge project files, not a pinned source commit. The feed’s file ID and release path are provenance, not a source tree.",
      ...(rows.some(row => row.sha256) ? [] : ["The feed has no SHA-256 publisher digest. Its MD5 values are recorded as evidence but are not accepted as integrity verification."]),
      "No license text tied to a pinned source revision was verified. Source import and installation are blocked.",
      "Archives are not downloaded or executed during this review; archive paths, game data, and a supported runnable layout remain unverified.",
    ],
    license: null, files: [], totalBytes: 0, releases: [...releasesByPath.values()],
  };
}

const providers: RepositoryAssessmentProvider[] = [{
  id: "github", accepts: url => url.protocol === "https:" && url.hostname === "github.com",
  assess: assessGithubRepository,
}, {
  id: "codeberg", accepts: url => url.protocol === "https:" && url.hostname === "codeberg.org",
  assess: assessCodebergRepository,
}, {
  id: "sourceforge", accepts: url => url.protocol === "https:" && url.hostname === "sourceforge.net",
  assess: assessSourceForgeRepository,
}];
export async function assessRepository(value: string, signal: AbortSignal) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RepositoryImportError("Enter a complete public repository HTTPS URL.", 400); }
  const provider = providers.find(provider => provider.accepts(url));
  if (!provider) throw new RepositoryImportError("No acquisition provider supports this URL. Use GitHub, Codeberg or a SourceForge project link.", 400);
  return provider.assess(value, signal);
}
const assessments = new Map<string, { owner: string; expiresAt: number; assessment: RepositoryAssessment }>();
export function rememberRepositoryAssessment(owner: string, assessment: RepositoryAssessment) {
  for (const [key, entry] of assessments) if (entry.expiresAt <= Date.now() || entry.owner === owner) assessments.delete(key);
  if (assessments.size >= 16) throw new RepositoryImportError("Repository reviews are busy. Try again shortly.", 429);
  const token = randomUUID(), expiresAt = Date.now() + 5 * 60_000;
  assessments.set(token, { owner, expiresAt, assessment });
  return { token, expiresAt, ...assessment };
}
export function recallRepositoryAssessment(owner: string, token: string) {
  const record = assessments.get(token);
  if (!record || record.owner !== owner || record.expiresAt <= Date.now()) throw new RepositoryImportError("Repository review expired or belongs to another owner. Assess the link again.", 409);
  return record.assessment;
}
