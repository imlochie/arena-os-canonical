import { access, copyFile, cp, mkdir, open, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CLASSIC_PINS } from "./arcade/classic-pins.mjs";
import { extractSelectedZip, sha256File } from "./arcade/pinned-zip.mjs";
import { packageDirectory } from "./arcade/directory-package.mjs";
import { buildDosCoin } from "./arcade/dos-fixture.mjs";
import { packageKey, safePackagePath } from "./arcade/packages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.dirname(here), cache = path.join(workspace, "generated-artifacts", "classic-upstream");
const signal = AbortSignal.timeout(12 * 60_000);
const allowedHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
  "codeload.github.com", "downloads.scummvm.org", "buildbot.libretro.com"]);
async function acquire(pin) {
  await mkdir(cache, { recursive: true });
  const filename = path.join(cache, pin.file);
  if (await sha256File(filename).catch(() => "") === pin.sha256) return filename;
  await rm(filename, { force: true });
  let response, url = new URL(pin.url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) throw new Error("Unapproved classic build-source host.");
    response = await fetch(url, { redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Invalid classic source redirect.");
    url = new URL(location, url);
  }
  if (!response?.ok) throw new Error(`Pinned ${pin.file} download failed: HTTP ${response?.status}.`);
  const partial = `${filename}.partial`, output = await open(partial, "w"), hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > pin.bytes) throw new Error("Pinned source exceeded its exact size.");
      hash.update(chunk); await output.writeFile(chunk);
    }
    if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("Classic source digest mismatch.");
    await output.close(); await copyFile(partial, filename); return filename;
  } finally { await output.close().catch(() => {}); await rm(partial, { force: true }); }
}
async function pe64(filename) {
  const fd = await open(filename, "r"), b = Buffer.alloc(4096);
  try { await fd.read(b, 0, b.length, 0); } finally { await fd.close(); }
  const offset = b.readUInt32LE(0x3C);
  if (b.toString("ascii", 0, 2) !== "MZ" || offset > b.length - 6 ||
      b.readUInt32LE(offset) !== 0x4550 || b.readUInt16LE(offset + 4) !== 0x8664) throw new Error(`Expected an actual Windows x64 PE: ${path.basename(filename)}.`);
}
function run(exe, args, cwd, extras = {}) {
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "COMSPEC"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const p = spawnSync(exe, args, { cwd, env: { ...env, ...extras }, shell: false, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error(`Classic build failed (${path.basename(exe)}): ${p.error?.message ?? p.stderr?.slice(-3000)}`);
  return p.stdout;
}
async function zip(pin, target) {
  return extractSelectedZip(await acquire(pin), target, n => {
    if (!n.startsWith(pin.prefix ?? "")) return null;
    const relative = n.slice((pin.prefix ?? "").length);
    // Offline site assets exceed portable TAR names and aren't an engine dependency.
    // Retain LICENSE.txt and doc/licenses; omit the separate debug executable.
    if (pin.id === "dosbox-staging" && (relative.startsWith("resources/docs/") || relative === "dosbox_with_debugger.exe")) return null;
    return relative;
  },
    signal, { maxFiles: 4000, maxBytes: 450 * 1024 ** 2 });
}
async function retroarch(pin, target, work) {
  if (process.platform !== "win32") throw new Error("RetroArch portable extraction requires the Windows build runner's 7-Zip.");
  const exe = process.env.ARENA_CLASSIC_7ZIP ?? "C:\\Program Files\\7-Zip\\7z.exe", source = await acquire(pin);
  const listing = run(exe, ["l", "-slt", "-ba", source], work);
  const rows = listing.split(/\r?\n\r?\n/).map(block => Object.fromEntries(block.split(/\r?\n/).filter(s => s.includes(" = ")).map(s => [s.slice(0, s.indexOf(" = ")), s.slice(s.indexOf(" = ") + 3)]))).filter(r => r.Path);
  if (!rows.length || rows.length > 40000) throw new Error("RetroArch archive directory exceeds its budget.");
  for (const r of rows) {
    const n = r.Path.replaceAll("\\", "/");
    if (/^[/]|^[a-z]:|[\0\r\n:]/i.test(n) || n.split("/").some(s => !s || s === ".." || s === ".") ||
        r["Symbolic Link"] || r["Hard Link"] || /L/.test(r.Attributes ?? "")) throw new Error("Unsafe RetroArch archive path/link.");
    r.name = n;
  }
  const main = rows.filter(r => /(^|\/)retroarch\.exe$/i.test(r.name));
  if (main.length !== 1) throw new Error("Upstream RetroArch executable layout changed.");
  const prefix = main[0].name.slice(0, -"retroarch.exe".length);
  const selected = rows.filter(r => r.Folder !== "+" && r.name.startsWith(prefix) &&
    (/^[^/]+\.(?:dll|exe)$/i.test(r.name.slice(prefix.length)) || /(?:^|\/)(?:COPYING|LICENSE|licences|licenses|legal|copyright)/i.test(r.name.slice(prefix.length))));
  if (selected.length > 2000 || selected.reduce((n, r) => n + Number(r.Size), 0) > 400 * 1024 ** 2) throw new Error("RetroArch selected files exceed package limits.");
  for (const r of selected) { safePackagePath(r.name); safePackagePath(r.name.slice(prefix.length)); }
  if (!selected.some(r => /COPYING|LICENSE/i.test(r.name))) throw new Error("RetroArch copyright/license notices missing.");
  const destination = path.join(work, "retro-extract"); await mkdir(destination);
  run(exe, ["x", "-y", "-spd", `-o${destination}`, source, ...selected.map(r => r.name)], work);
  for (const r of selected) {
    const relative = r.name.slice(prefix.length), output = path.join(target, ...relative.split("/"));
    await mkdir(path.dirname(output), { recursive: true }); await copyFile(path.join(destination, ...r.name.split("/")), output);
  }
}
export async function preparePortableRuntime(pin, target, work) {
  await mkdir(target, { recursive: true });
  if (pin.file.endsWith(".7z")) await retroarch(pin, target, work); else await zip(pin, target);
  await pe64(path.join(target, pin.entry));
  await writeFile(path.join(target, "ARENA-SOURCE.txt"), `Official upstream archive: ${pin.url}\nSHA256: ${pin.sha256}\nBytes: ${pin.bytes}\nSource: ${pin.source}\nLicense: ${pin.license}\nThis is acquisition evidence, not gameplay/containment/audio/save acceptance.\nPublic redistribution requires satisfying all bundled licenses and corresponding-source obligations.\n`);
}
export async function buildClassicPackages(output = path.join(workspace, "generated-artifacts", "arcade-native-packages")) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build complete classic packages on Windows x64; no unsupported-host native launch fallback.");
  await mkdir(output, { recursive: true });
  const disk = await statfs(output);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error("Classic package preparation needs 2 GiB free build space. These are separate optional packages, never installer payload.");
  const work = path.join(output, "classic-work"); await rm(work, { recursive: true, force: true }); await mkdir(work);
  const packages = [], roots = new Map();
  async function bundle(pin, root, extra = {}) {
    const descriptor = await packageDirectory(root, path.join(output, `${pin.id}-${pin.version}.tar`), {
      id: pin.id, version: pin.version, kind: "runtime", host: "windows-x64", license: pin.license, runtimes: [],
      classicRuntime: { adapter: pin.adapter, entry: pin.entry, source: pin.source, license: pin.license, ...(pin.adapter === "gambatte-libretro" ? { api: 1 } : {}) }, ...extra });
    packages.push(descriptor); roots.set(pin.adapter, packageKey(descriptor)); return descriptor;
  }
  try {
    for (const pin of [CLASSIC_PINS.dosbox, CLASSIC_PINS.scummvm, CLASSIC_PINS.sameboy, CLASSIC_PINS.retroarch]) {
      const target = path.join(work, pin.id); await preparePortableRuntime(pin, target, work); await bundle(pin, target);
    }
    const pin = CLASSIC_PINS.gambatte, source = path.join(work, "gambatte-source"), core = path.join(work, "gambatte");
    await zip(pin, source); await mkdir(core);
    const toolchain = process.env.ARENA_CLASSIC_MINGW ?? "C:\\msys64\\mingw64\\bin";
    run(path.join(toolchain, "mingw32-make.exe"), ["-f", "Makefile.libretro", "platform=win", "-j2",
      `CC=${path.join(toolchain, "gcc.exe").replaceAll("\\", "/")} -static`,
      `CXX=${path.join(toolchain, "g++.exe").replaceAll("\\", "/")} -static -static-libgcc -static-libstdc++`,
      "GIT_VERSION=77f2567d"], source, { PATH: `${toolchain};C:\\msys64\\usr\\bin;${process.env.PATH ?? ""}` });
    await pe64(path.join(source, pin.entry)); await copyFile(path.join(source, pin.entry), path.join(core, pin.entry));
    const coreBytes = await readFile(path.join(core, pin.entry));
    for (const name of ["libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"])
      if (coreBytes.includes(Buffer.from(name, "ascii"))) throw new Error("Core must statically link its compiler runtimes, not depend on a host MinGW installation.");
    for (const name of ["gcc", "gcc-libs", "winpthreads"]) {
      const notices = path.join(path.dirname(toolchain), "share", "licenses", name);
      if (await access(notices).then(() => true, () => false)) await cp(notices, path.join(core, "compiler-notices", name), { recursive: true });
    }
    for (const file of await readdir(source)) if (/copying|license/i.test(file)) await cp(path.join(source, file), path.join(core, file), { recursive: true });
    await copyFile(await acquire(pin), path.join(core, "corresponding-source.zip"));
    await writeFile(path.join(core, "ARENA-SOURCE.txt"), `${pin.url}\nSHA256 ${pin.sha256}\n${run(path.join(toolchain, "g++.exe"), ["--version"], source)}\nAPI 1; GB/GBC only. Not arbitrary Libretro compatibility or Windows gameplay proof.\n`);
    const corePin = { ...pin, version: `${pin.version}-${(await sha256File(path.join(core, pin.entry))).slice(0, 12)}` };
    await bundle(corePin, core);

    const fixture = async (id, root, entry, adapter, engine, license) => {
      const classic = { adapter, runtime: roots.get(adapter === "libretro" ? "retroarch" : adapter),
        ...(adapter === "libretro" ? { core: roots.get("gambatte-libretro") } : {}), ...(engine ? { engine } : {}) };
      packages.push(await packageDirectory(root, path.join(output, `${id}-1.tar`), {
        id, version: "1", kind: "game", host: "windows-x64", entry, arguments: [], license, runtimes: [classic.runtime, classic.core].filter(Boolean), classic }));
    };
    const dos = path.join(work, "coin-dos"); await mkdir(dos);
    await writeFile(path.join(dos, "COIN.COM"), buildDosCoin());
    await copyFile(path.join(here, "arcade", "dos-fixture.mjs"), path.join(dos, "SOURCE.MJS"));
    await writeFile(path.join(dos, "LICENSE.TXT"), "Original Arena Coin Counter; MIT. Source generator is SOURCE.MJS. No proprietary assets.\nSpace collects; A/D move; Q saves and exits. Progress: C:\\PROGRESS.SAV.\n");
    await fixture("arena-dos-coin", dos, "COIN.COM", "dosbox-staging", null, "MIT original Arena DOS homebrew");
    const sdk = path.join(work, "gbdk"), gb = path.join(work, "coin-gb"); await zip(CLASSIC_PINS.gbdk, sdk); await mkdir(gb);
    await copyFile(path.join(here, "native", "classic-coin.c"), path.join(gb, "coin.c"));
    run(path.join(sdk, "bin", "lcc.exe"), ["-Wm-yt0x03", "-Wm-yo2", "-Wm-ya1", "-Wm-ynARENA-COIN", "-o", "coin.gb", "coin.c"], gb);
    const rom = await readFile(path.join(gb, "coin.gb"));
    if (rom.length !== 32768 || rom[0x147] !== 3 || rom[0x149] !== 2) throw new Error("Fixture must be a real 32 KiB MBC1 battery/SRAM cartridge.");
    await cp(path.join(sdk, "licenses"), path.join(gb, "licenses"), { recursive: true });
    await writeFile(path.join(gb, "README.txt"), "Arena Coin Trail: original MIT homebrew, source coin.c. GBDK 4.5.0/SDCC runtime notices and exceptions in licenses. Arrows move; A collects at coin; B resets. Reach 9. Collecting sounds a tone. Battery SRAM retains score on an ordinary emulator exit. No proprietary BIOS/game assets.\n");
    await fixture("arena-libretro-coin", gb, "coin.gb", "libretro", null, "MIT original homebrew; GBDK/SDCC linked-library terms/exceptions retained");
    await fixture("arena-sameboy-coin", gb, "coin.gb", "sameboy", null, "MIT original homebrew; GBDK/SDCC linked-library terms/exceptions retained");
    const bass = path.join(work, "bass"); await zip(CLASSIC_PINS.bass, bass);
    const names = await readdir(bass), entry = names.find(n => n.toLowerCase() === "sky.dnr");
    if (!entry || !names.some(n => n.toLowerCase() === "sky.dsk") || !names.some(n => n.toLowerCase() === "readme.txt")) throw new Error("Official freeware data/notices missing.");
    await fixture("revolution-bass-freeware", bass, entry, "scummvm", "sky", "Beneath a Steel Sky (C) Revolution Software Ltd.; freeware, not public-domain/open-source data. Unmodified official readme and attribution retained; no separate game fee.");
    const file = path.join(output, "arcade-catalog.json"), old = JSON.parse(await readFile(file, "utf8").catch(() => '{"schemaVersion":1,"packages":[]}'));
    const keys = new Set(packages.map(packageKey));
    await writeFile(file, JSON.stringify({ schemaVersion: 1, packages: [...old.packages.filter(d => !keys.has(packageKey(d))), ...packages] }, null, 2));
    return packages;
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildClassicPackages(process.argv[2]); console.log("Classic packages acquired/built. Windows gameplay acceptance remains unverified.");
}
