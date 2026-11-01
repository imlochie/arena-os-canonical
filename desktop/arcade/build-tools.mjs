import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadPinnedZip, extractSelectedZip, sha256File } from "./pinned-zip.mjs";

// Publisher release digests observed from the official GitHub release API.
// Updates are deliberate application changes, never "latest" at runtime.
export const BUILD_TOOLS = Object.freeze({
  godot: { id: "godot", version: "4.7.2", bytes: 86013866, unpackedBudget: 240 * 1024 * 1024,
    sha256: "731980f9608d61333e5baf54a2ef17210acc7a538446c0cb9969f002aca1e953",
    url: "https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_win64.exe.zip",
    license: "MIT; Godot Engine and its bundled third-party notices: https://godotengine.org/license/",
    executable: "Godot_v4.7.2-stable_win64_console.exe" },
  llvm: { id: "llvm", version: "20261020", bytes: 190612575, unpackedBudget: 1100 * 1024 * 1024,
    sha256: "fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd",
    url: "https://github.com/mstorsjo/llvm-mingw/releases/download/20261020/llvm-mingw-20261020-ucrt-x86_64.zip",
    license: "LLVM Apache-2.0 WITH LLVM-exception, mingw-w64 and bundled notices retained in SDK.",
    executable: "bin/clang.exe" },
  sdl: { id: "sdl", version: "2.32.10", bytes: 14260563, unpackedBudget: 90 * 1024 * 1024,
    sha256: "f15cff5fca62ec9381a016ef1d42a95c638cd72d2f226ba5781c76fe43dbd1ac",
    url: "https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-devel-2.32.10-mingw.zip",
    license: "Zlib; SDL2 copyright notices retained in SDK.",
    executable: "x86_64-w64-mingw32/bin/SDL2.dll" },
});
export function selectToolFile(id, name) {
  if (id === "godot") return /^Godot_v4\.7\.2-stable_win64(?:_console)?\.exe$/.test(name) ? name : null;
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const relative = name.slice(slash + 1);
  if (id === "sdl") return relative.startsWith("x86_64-w64-mingw32/") || /^(?:COPYING|LICENSE|README)[^.]*\.(?:txt|md)$/i.test(relative) ? relative : null;
  if (id === "llvm") return /^(?:bin\/|include\/|lib\/clang\/|x86_64-w64-mingw32\/|generic-w64-mingw32\/)/.test(relative) ||
    /^(?:LICENSE|COPYING|NOTICE)[^/]*$/i.test(relative) ? relative : null;
  throw new Error("Unsupported pinned toolchain.");
}

async function inventory(root, signal, relative = "", rows = []) {
  for (const row of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    signal.throwIfAborted();
    const name = relative ? `${relative}/${row.name}` : row.name;
    if (name === ".verified.json") continue;
    if (rows.length > 18000 || row.isSymbolicLink()) throw new Error("SDK inventory exceeds its safety bounds.");
    if (row.isDirectory()) await inventory(root, signal, name, rows);
    else if (row.isFile()) rows.push({ path: name, sha256: await sha256File(path.join(root, name), signal) });
    else throw new Error("SDK contains a special file.");
  }
  return rows;
}
export class BuildTools {
  constructor({ packages, log, preflight }) {
    this.packages = packages; this.log = log; this.preflight = preflight;
    this.root = path.join(packages.root, "build-cache", "toolchains");
  }
  async ensure(id, signal) {
    const pin = BUILD_TOOLS[id];
    if (!pin) throw new Error("Unregistered build SDK.");
    await mkdir(this.root, { recursive: true });
    const destination = path.join(this.root, `${id}-${pin.version}-${pin.sha256.slice(0, 16)}`);
    try {
      const raw = await readFile(path.join(destination, ".verified.json"), "utf8");
      if (raw.length > 8 * 1024 * 1024) throw new Error("SDK manifest exceeds its limit.");
      const manifest = JSON.parse(raw);
      if (manifest.archiveSha256 !== pin.sha256) throw new Error("SDK pin changed.");
      const actual = await inventory(destination, signal);
      if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("SDK files changed. Repair is required.");
      this.log(`Reusing verified ${id} ${pin.version}.`);
      return { pin, directory: destination };
    } catch (error) {
      signal.throwIfAborted();
      if (error.code !== "ENOENT") throw new Error(`Cached ${id} SDK could not be verified: ${error.message}. Reset this SDK in Native games and retry; installed games and saves are untouched.`);
    }
    await this.preflight(pin.bytes + pin.unpackedBudget * 2);
    const archive = path.join(this.root, `${pin.sha256}.zip`);
    const staging = path.join(this.root, `staging-${id}-${randomUUID()}`);
    let lastProgress = 0;
    try {
      this.log(`Acquiring pinned ${id} ${pin.version}: ${pin.bytes} compressed bytes; maximum ${pin.unpackedBudget} extracted bytes.`);
      await downloadPinnedZip(pin, archive, signal, (done, total) => {
        if (done - lastProgress > 8 * 1024 * 1024 || done === total) { lastProgress = done; this.log(`${id} download ${Math.round(done / total * 100)}%.`); }
      });
      await extractSelectedZip(archive, staging, name => selectToolFile(id, name), signal, { maxBytes: pin.unpackedBudget });
      // A publisher digest is checked before any executable is used. No setup
      // script, global package manager or repository command is invoked.
      const files = await inventory(staging, signal);
      if (!files.some(file => file.path === pin.executable)) throw new Error("Publisher SDK layout does not match the pinned recipe.");
      await writeFile(path.join(staging, ".verified.json"), JSON.stringify({ archiveSha256: pin.sha256, files }), { flag: "wx" });
      // Only this exact pinned, disposable SDK directory is replaceable. It
      // never contains profiles, user-authored source or an installed game.
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      await rm(archive, { force: true }); // Do not retain a second full SDK ZIP.
      return { pin, directory: destination };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async reset(id) {
    const pin = BUILD_TOOLS[id];
    if (!pin) throw new Error("Choose a registered build SDK.");
    await rm(path.join(this.root, `${id}-${pin.version}-${pin.sha256.slice(0, 16)}`), { recursive: true, force: true });
    await rm(path.join(this.root, `${pin.sha256}.zip`), { force: true });
    await rm(path.join(this.root, `${pin.sha256}.zip.partial`), { force: true });
  }
}
