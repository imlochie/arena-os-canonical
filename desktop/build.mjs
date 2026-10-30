import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, mkdir, rm, access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stageFfmpegBundle } from "./ffmpeg-bundle.mjs";
import { verifyOnnxRuntime } from "./onnx-runtime-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const require = createRequire(import.meta.url);
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));

async function findPackageRoot(entry, expectedName) {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === expectedName) return { directory, manifest };
    } catch {
      // Keep walking until the package manifest is found.
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate the installed ${expectedName} package.`);
}

/** Copy an external Node runtime and its dependencies into a portable node_modules tree. */
export async function copyExternalPackage(packageName, sourceRequire, destinationNodeModules, state = { copied: new Set(), ancestors: new Set() }) {
  let entry;
  try {
    entry = sourceRequire.resolve(packageName);
  } catch {
    // Type-only packages (such as type-fest) have a package.json but no JS entry.
    entry = sourceRequire.resolve(`${packageName}/package.json`);
  }
  const { directory: sourceRoot, manifest } = await findPackageRoot(entry, packageName);
  const destination = path.join(destinationNodeModules, ...packageName.split("/"));
  const destinationKey = path.resolve(destination);
  if (!state.copied.has(destinationKey)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceRoot, destination, { recursive: true, dereference: true });
    state.copied.add(destinationKey);
  }

  const packageKey = `${manifest.name}@${manifest.version}`;
  if (state.ancestors.has(packageKey)) return destination;
  const nextState = {
    copied: state.copied,
    ancestors: new Set([...state.ancestors, packageKey]),
  };
  const packageRequire = createRequire(entry);
  const optionalDependencies = manifest.optionalDependencies ?? {};
  for (const dependencyName of Object.keys({
    ...(manifest.dependencies ?? {}),
    ...optionalDependencies,
  })) {
    try {
      await copyExternalPackage(
        dependencyName,
        packageRequire,
        path.join(destination, "node_modules"),
        nextState,
      );
    } catch (error) {
      if (Object.hasOwn(optionalDependencies, dependencyName)) continue;
      throw new Error(
        `Could not stage ${manifest.name} dependency ${dependencyName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return destination;
}

export function runPnpm(args, env = {}) {
  // Resolve the pnpm JS entry rather than invoking a .cmd shim through a shell.
  const entry = process.env.npm_execpath;
  if (!entry || !/\.(?:c?js|mjs)$/.test(entry)) throw new Error("Run this build through pnpm");
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.status})`);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Build the Windows package on Windows x64. Linux builds cannot verify the shipped native dependencies.");
  }
  runPnpm(["--filter", "@workspace/arenaforge", "run", "build"], {
    NODE_ENV: "production", BASE_PATH: "/", PORT: "5173",
  });
  runPnpm(["--filter", "@workspace/api-server", "run", "build"]);

  const stage = path.join(here, "stage");
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "server", "node_modules"), { recursive: true });
  await stageFfmpegBundle({
    cacheDir: path.join(root, "generated-artifacts", "windows-tool-cache"),
    destinationBin: path.join(stage, "bin"),
  });
  await cp(path.join(root, "artifacts/api-server/dist"), path.join(stage, "server"), { recursive: true });
  await cp(path.join(root, "artifacts/arenaforge/dist/public"), path.join(stage, "web"), { recursive: true });
  const playwrightRoot = path.dirname(require.resolve("playwright-core/package.json"));
  await cp(playwrightRoot, path.join(stage, "server/node_modules/playwright-core"), { recursive: true });
  await copyExternalPackage(
    "onnxruntime-node",
    apiRequire,
    path.join(stage, "server/node_modules"),
  );
  const stagedRequire = createRequire(path.join(stage, "server/index.mjs"));
  const onnxRuntime = stagedRequire("onnxruntime-node");
  if (typeof onnxRuntime.InferenceSession?.create !== "function") {
    throw new Error("The staged ONNX Runtime did not expose InferenceSession.create.");
  }
  await verifyOnnxRuntime(onnxRuntime, path.join(stage, "server"));

  // Download the Chromium revision matching the exact installed Playwright.
  runPnpm(["--filter", "@workspace/desktop", "exec", "playwright-core", "install", "chromium"]);
  const { chromium } = require("playwright-core");
  const chrome = chromium.executablePath();
  await access(chrome);
  await cp(path.dirname(chrome), path.join(stage, "chromium"), { recursive: true });
  const postgresRoot = path.dirname(require.resolve("@embedded-postgres/windows-x64/package.json"));
  await cp(path.join(postgresRoot, "native"), path.join(stage, "embedded-postgres"), { recursive: true });
  for (const binary of ["postgres.exe", "initdb.exe", "pg_ctl.exe"]) {
    await access(path.join(stage, "embedded-postgres", "bin", binary));
  }
  await access(path.join(stage, "chromium", "chrome.exe"));
  await build({
    entryPoints: [path.join(here, "main.mjs")], outfile: path.join(here, "dist/main.cjs"),
    bundle: true, platform: "node", format: "cjs",
    external: ["electron", "pg-native"], target: "node22",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
