/**
 * Resolve hook (off-thread) backing scripts/register-src-loader.mjs.
 *
 * Three conveniences for direct Node execution (not used by Next):
 *  1. `@/x/y`            → <repo>/src/x/y.{ts,tsx,js,mjs} (or index files)
 *  2. extensionless relative imports (legal under the repo's "bundler"
 *     moduleResolution) gain their real extension so Node's native
 *     TypeScript type-stripping can load them.
 *  3. bare subpath imports that only resolve through CommonJS rules (a
 *     package with no "exports" map and an extensionless file, e.g.
 *     `next/server`) fall back to require.resolve — so a test can import a
 *     real route module, which imports `next/server`, under native ESM.
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

const require = createRequire(import.meta.url);

const SRC = resolvePath(fileURLToPath(new URL("../src", import.meta.url)));
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json"];

function withExtension(basePath) {
  for (const ext of EXTENSIONS) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }
  for (const ext of EXTENSIONS) {
    const candidate = join(basePath, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const found = withExtension(join(SRC, specifier.slice(2)));
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    throw new Error(`src loader: cannot resolve ${specifier}`);
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (
        error &&
        (error.code === "ERR_MODULE_NOT_FOUND" ||
          error.code === "ERR_UNKNOWN_FILE_EXTENSION" ||
          error.code === "ERR_UNSUPPORTED_DIR_IMPORT")
      ) {
        const parentDir = dirname(fileURLToPath(context.parentURL));
        const found = withExtension(resolvePath(parentDir, specifier));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      throw error;
    }
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error &&
      (error.code === "ERR_MODULE_NOT_FOUND" ||
        error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
        error.code === "ERR_UNSUPPORTED_DIR_IMPORT")
    ) {
      // Node's ESM resolver wants a file extension for subpaths of packages
      // that ship no "exports" map (`next/server` → next/server.js). The
      // bundler-style resolution the app compiles with accepts them, so the
      // direct-Node loader follows the same rule via CommonJS resolution.
      try {
        return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
      } catch {
        // Not a CommonJS-resolvable bare specifier — rethrow the ESM error.
      }
    }
    throw error;
  }
}
