import { randomUUID } from "node:crypto";
import {
  RepositoryImportError, readRepositoryFile, readRepositoryLicense, resolveRepositoryTree, safeGithubBytes,
  type ReadBytes, type RepositoryFile, type RepositoryProvenance,
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
    return (await readRepositoryFile(link.repository, revision, file, signal, read)).toString("utf8");
  };
  let license: RepositoryAssessment["license"] = null;
  try { license = await readRepositoryLicense(snapshot); }
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
  const rawReleases = await json("/releases?per_page=3", 256 * 1024);
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
      const expected = `https://github.com/${link.repository}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
      if (asset.browser_download_url !== expected) continue;
      assets.push({ name: asset.name, url: expected, bytes: asset.size, sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ? asset.digest.slice(7) : null });
    }
    releases.push({ name: typeof release.name === "string" ? release.name.slice(0, 200) : tag, tag,
      reviewUrl: `https://github.com/${link.repository}/releases/tag/${tag}`, prerelease: release.prerelease === true, assets });
  }
  return { provider: "github", repository: link.repository, revision, reference: snapshot.reference, folder: link.folder,
    sourceUrl: `https://github.com/${link.repository}/tree/${revision}`, projectType, confidence, languages: [...languages],
    buildSystems, dependencies, sdks, targets, modHooks, evidence, blockers, license, files, totalBytes, releases };
}

const providers: RepositoryAssessmentProvider[] = [{
  id: "github", accepts: url => url.protocol === "https:" && url.hostname === "github.com",
  assess: assessGithubRepository,
}];
export async function assessRepository(value: string, signal: AbortSignal) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RepositoryImportError("Enter a complete public repository HTTPS URL.", 400); }
  const provider = providers.find(provider => provider.accepts(url));
  if (!provider) throw new RepositoryImportError("No acquisition provider supports this URL. GitHub is currently the only registered provider.", 400);
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
