/**
 * Windows platform-package preflight.
 *
 * The packaged desktop app does not use whatever FFmpeg happens to be on PATH:
 * it stages `@ffmpeg-installer/win32-x64` and `@ffprobe-installer/win32-x64`
 * into the installer, and embeds `@embedded-postgres/windows-x64`. A missing
 * platform package therefore fails at packaging time (or silently ships an app
 * without media export), which is exactly the class of defect this check makes
 * loud and early.
 *
 * Root cause this guards: package.json declared only
 * `@ffmpeg-installer/linux-x64`, so npm's platform filtering meant a Windows
 * `npm ci` installed no FFmpeg binary at all and `desktop:prepare-server`
 * aborted with "Could not find ffmpeg binary".
 *
 * Non-Windows hosts: the Windows package layout cannot be verified there, so
 * this reports NOT APPLICABLE and exits 0 (never a fake pass).
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const platform = process.platform;

if (platform !== "win32") {
  console.log(
    JSON.stringify(
      {
        kind: "windows-platform-packages",
        status: "NOT APPLICABLE",
        platform,
        note: "This preflight asserts the Windows package layout; run it on windows-latest or a Windows machine.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const checks = [
  { name: "embedded PostgreSQL", path: "node_modules/@embedded-postgres/windows-x64/native/bin/initdb.exe" },
  { name: "embedded PostgreSQL server", path: "node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" },
  { name: "FFmpeg", path: "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe" },
  { name: "FFprobe", path: "node_modules/@ffprobe-installer/win32-x64/ffprobe.exe" },
  { name: "onnxruntime native binding", path: `node_modules/onnxruntime-node/bin/napi-v6/win32/${process.arch}`, directory: true },
];

const results = checks.map(({ name, path: relative, directory = false }) => {
  const absolute = path.join(root, relative);
  // A native binding is a directory of DLLs; the media/DB binaries are files.
  const present = existsSync(absolute) && (directory ? statSync(absolute).isDirectory() : statSync(absolute).isFile());
  return {
    name,
    path: relative,
    present,
    bytes: present && !directory ? statSync(absolute).size : 0,
  };
});

const report = {
  kind: "windows-platform-packages",
  status: results.every((entry) => entry.present) ? "PASS" : "FAIL",
  platform,
  arch: process.arch,
  node: process.version,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") {
  console.error(
    "Missing Windows platform packages. Every packaged feature that needs one of these would be broken in the installer.",
  );
  process.exit(1);
}
