// Compatibility preflight only. Never executes a loader, plugin or install hook.
import path from "node:path";
import { safePackagePath } from "./packages.mjs";

export const BEPINEX_RELEASES = Object.freeze({
  "windows-x64": Object.freeze({
    version: "5.4.23.2",
    url: "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_x64_5.4.23.2.zip",
    bytes: 637157,
    sha256: "f752ce4e838f4c305b9da1404b6745f2cff23b8bfd494f79f0c84d0a01f59b46",
  }),
  "linux-x64": Object.freeze({
    version: "5.4.23.2",
    url: "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_linux_x64_5.4.23.2.zip",
    bytes: 640773,
    sha256: "ddc446143a0a277ed92eb7a1f5bf794ff4fdd0023bddc0491f85eafd1898225b",
  }),
});

export function identifyExecutable(header) {
  const bytes = Buffer.from(header ?? []);
  if (bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(60);
    if (offset < 64 || offset > bytes.length - 24 || bytes.toString("ascii", offset, offset + 4) !== "PE\0\0")
      return null;
    const machine = bytes.readUInt16LE(offset + 4);
    return { platform: "windows", arch: machine === 0x8664 ? "x64" : machine === 0x14c ? "x86" : "unsupported" };
  }
  if (bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      bytes[5] === 1 && bytes[6] === 1) {
    const machine = bytes.readUInt16LE(18);
    return { platform: "linux", arch: bytes[4] === 2 && machine === 62 ? "x64" : bytes[4] === 1 && machine === 3 ? "x86" : "unsupported" };
  }
  return null;
}

export function assessUnityMonoLayout({ files, entry, header, host }) {
  const result = {
    framework: "bepinex-5", evidence: "package-layout-and-executable-header",
    candidate: false, canInstall: false, gameplayVerified: false,
    blockers: [], installationBlockers: ["The dedicated loader installation/execution adapter is not yet verified."],
  };
  if (!BEPINEX_RELEASES[host]) result.blockers.push("Only Windows x64 and Linux x64 loader distributions have been pinned.");
  if (!Array.isArray(files) || files.length > 2000 || !entry) {
    result.blockers.push("A bounded verified game inventory and explicit executable are required.");
    return result;
  }
  try {
    safePackagePath(entry);
    files.forEach(file => safePackagePath(file));
  } catch {
    result.blockers.push("The game inventory contains an unsafe path.");
    return result;
  }
  const names = new Set(files);
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length)
    result.blockers.push("Duplicate or case-colliding game paths are not supported.");
  if (!names.has(entry)) result.blockers.push("The executable is absent from the verified inventory.");
  const identity = identifyExecutable(header);
  if (!identity || `${identity.platform}-${identity.arch}` !== host)
    result.blockers.push("The actual executable header does not match the selected host architecture.");
  const directory = path.posix.dirname(entry);
  const prefix = directory === "." ? "" : directory + "/";
  const filename = path.posix.basename(entry);
  const stem = filename.replace(/\.(?:exe|x86_64|x86)$/i, "");
  const data = `${prefix}${stem}_Data`;
  if (!names.has(`${data}/Managed/Assembly-CSharp.dll`) || !names.has(`${data}/globalgamemanagers`))
    result.blockers.push("The selected executable lacks the supported Unity managed game layout; another game's files do not count.");
  const monoPaths = host === "windows-x64"
    ? [`${prefix}MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll`, `${data}/Mono/mono.dll`]
    : [`${prefix}MonoBleedingEdge/EmbedRuntime/libmonobdwgc-2.0.so`, `${data}/Mono/x86_64/libmono.so`];
  if (!monoPaths.some(file => names.has(file)))
    result.blockers.push("No recognized Mono runtime accompanies this executable.");
  if (files.some(file => file === `${prefix}GameAssembly.dll` || file === `${prefix}GameAssembly.so` ||
      file.startsWith(`${data}/il2cpp_data/`)))
    result.blockers.push("IL2CPP or a mixed backend layout is outside this BepInEx 5 Mono pathway.");
  if (files.some(file => file.toLowerCase().startsWith(`${prefix}BepInEx/`.toLowerCase()) ||
      [`${prefix}winhttp.dll`, `${prefix}doorstop_config.ini`, `${prefix}libdoorstop.so`, `${prefix}run_bepinex.sh`]
        .some(marker => marker.toLowerCase() === file.toLowerCase())))
    result.blockers.push("An existing loader/proxy installation must be reviewed separately; it will not be overwritten.");
  result.candidate = result.blockers.length === 0;
  result.distribution = BEPINEX_RELEASES[host] ?? null;
  return result;
}
