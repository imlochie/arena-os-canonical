import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPinnedPackage } from "./arcade/tar-build.mjs";
import { fetchWithTransientRetries } from "./arcade/retry-fetch.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../generated-artifacts/arcade-native-packages");
const archiveDigest = "6cf9706eefd0a4a06dc764007934d428afaf029fabdd408a9e646048c91e18fb";
export async function buildArcadeFixture() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build the native SDL fixture with Windows x64 MSVC; no Linux-generated Windows execution claim.");
  await mkdir(output, { recursive: true });
  const source = path.join(output, "SDL2.zip");
  let zip;
  try { zip = await readFile(source); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!zip || zip.length !== 608965 || createHash("sha256").update(zip).digest("hex") !== archiveDigest) {
    const response = await fetchWithTransientRetries("https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-2.32.10-win32-x64.zip", { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("Could not acquire pinned SDL release.");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 608965) throw new Error("SDL release exceeded its pinned size."); chunks.push(chunk); }
    zip = Buffer.concat(chunks);
    if (bytes !== 608965 || createHash("sha256").update(zip).digest("hex") !== archiveDigest) throw new Error("SDL publisher release digest mismatch.");
    await writeFile(source, zip);
  }
  const extraction = path.join(output, "SDL2");
  const extractionCommand = `Expand-Archive -LiteralPath '${source.replaceAll("'", "''")}' -DestinationPath '${extraction.replaceAll("'", "''")}' -Force`;
  const extracted = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(extractionCommand, "utf16le").toString("base64")], { shell: false, stdio: "inherit" });
  if (extracted.error || extracted.status !== 0) throw extracted.error ?? new Error("SDL release extraction failed.");
  const compiled = spawnSync("cl.exe", ["/nologo", "/std:c++20", "/EHsc", "/O2", "/MT", "/W4", "/utf-8",
    `/Fo${path.join(output, "fixture.obj")}`, `/Fe${path.join(output, "arena-sdl.exe")}`, path.join(here, "native/arcade-sdl-fixture.cpp")], { shell: false, stdio: "inherit" });
  if (compiled.error || compiled.status !== 0) throw compiled.error ?? new Error("Original SDL game compilation failed.");
  const runtime = buildPinnedPackage({ id: "arena.sdl2", version: "2.32.10", kind: "runtime",
    license: "SDL zlib license; original publisher README included.", files: [
      { path: "SDL2.dll", data: await readFile(path.join(extraction, "SDL2.dll")) },
      { path: "README-SDL.txt", data: await readFile(path.join(extraction, "README-SDL.txt")) },
    ] });
  const gameBytes = await readFile(path.join(output, "arena-sdl.exe"));
  const game = buildPinnedPackage({ id: "arena.sdl-fixture", version: `0.1.0+${createHash("sha256").update(gameBytes).digest("hex").slice(0, 16)}`, kind: "game",
    entry: "arena-sdl.exe", arguments: ["{runtime}", "{profile}"], runtimes: [`${runtime.descriptor.id}@${runtime.descriptor.version}`],
    license: "MIT; original Arena SDL fixture source included.", files: [
      { path: "arena-sdl.exe", data: gameBytes },
      { path: "source/arcade-sdl-fixture.cpp", data: await readFile(path.join(here, "native/arcade-sdl-fixture.cpp")) },
      { path: "LICENSE.txt", data: "MIT License\nCopyright Arena contributors\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies, subject to including this notice. THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM THE SOFTWARE OR ITS USE." },
    ] });
  for (const item of [runtime, game]) await writeFile(path.join(output, `${item.descriptor.id}@${item.descriptor.version}.tar`), item.archive);
  const catalog = { schemaVersion: 1, packages: [runtime.descriptor, game.descriptor] };
  await writeFile(path.join(output, "arcade-catalog.json"), JSON.stringify(catalog, null, 2));
  return { output, catalog };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildArcadeFixture().catch(error => { console.error(error.message); process.exitCode = 1; });
