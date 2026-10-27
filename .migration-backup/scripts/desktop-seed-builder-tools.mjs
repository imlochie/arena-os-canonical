/**
 * Seed electron-builder's toolchain archive cache from local files — the
 * offline path to the NSIS installer on networks where github downloads
 * die mid-transfer.
 *
 *   node scripts/desktop-seed-builder-tools.mjs <nsis-3.0.4.1.7z> [nsis-resources-3.4.1.7z ...]
 *   node scripts/desktop-seed-builder-tools.mjs --status
 *
 * Obtain the archives ONCE (browser download usually succeeds where Node's
 * fetch is cut off) from:
 *   https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z
 *   https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z
 *   https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
 *
 * The script verifies each file's SHA-256 against the checksums
 * app-builder-lib itself enforces, then places it in the archive cache
 * electron-builder checks BEFORE any network access. Integrity is fully
 * preserved — electron-builder still unpacks + validates with its own
 * machinery.
 */

import { statSync } from "node:fs";

import {
  KNOWN_TOOLS,
  TOOL_SOURCE_URLS,
  ToolSeedError,
  assertTableMatchesInstalledLib,
  builderCacheRoot,
  seedArchive,
  toolStatus,
} from "./lib/builder-tools.mjs";
import { repoRootFromMeta } from "./lib/repo-root.mjs";

const root = repoRootFromMeta(import.meta.url);
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/desktop-seed-builder-tools.mjs <archive.7z> [archive.7z …]");
  console.log("       node scripts/desktop-seed-builder-tools.mjs --status");
  console.log("\nexpected archives (download with a BROWSER from):");
  for (const [name, url] of Object.entries(TOOL_SOURCE_URLS)) {
    console.log(`  ${name}\n    ${url}`);
  }
  process.exit(args.length === 0 ? 1 : 0);
}

try {
  await assertTableMatchesInstalledLib(root);
} catch (error) {
  console.error(`[seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (args.includes("--status")) {
  const cacheRoot = builderCacheRoot();
  console.log(`[seed] electron-builder cache root: ${cacheRoot}`);
  for (const tool of toolStatus(cacheRoot)) {
    const state = tool.extracted ? "extracted (cached)" : tool.archiveSeeded ? "seeded (will unpack on next build)" : "MISSING";
    console.log(`  ${state.padEnd(34)} ${tool.name} — ${tool.purpose}`);
  }
  process.exit(0);
}

const cacheRoot = builderCacheRoot();
let placed = 0;
let failures = 0;
for (const file of args) {
  try {
    const result = await seedArchive(file, { cacheRoot });
    console.log(`[seed] ${result.name} → ${result.archiveCachePath} (sha256 verified)`);
    placed += 1;
  } catch (error) {
    failures += 1;
    console.error(`[seed] FAILED ${file}: ${error instanceof ToolSeedError ? error.message : String(error)}`);
  }
}

console.log(`[seed] cache root: ${cacheRoot}`);
for (const tool of toolStatus(cacheRoot)) {
  const state = tool.extracted ? "extracted (cached)" : tool.archiveSeeded ? "seeded" : "MISSING";
  console.log(`  ${state.padEnd(20)} ${tool.name}`);
}
if (failures > 0) {
  console.error(`[seed] ${failures} file(s) failed — nothing was placed for them; fix and re-run.`);
  process.exit(1);
}
console.log(`[seed] ${placed} archive(s) placed. Run: npm run desktop:dist`);
