/**
 * Resolve hook (off-thread) backing scripts/register-test-alias.mjs.
 *
 * Two conveniences, test-only:
 *  1. `@/x/y`            → <repo>/src/x/y.{ts,tsx,js,mjs} (or index files)
 *  2. extensionless relative imports (legal under the repo's "bundler"
 *     moduleResolution) gain their real extension so Node's native
 *     TypeScript type-stripping can load them.
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

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
    throw new Error(`test alias loader: cannot resolve ${specifier}`);
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_UNKNOWN_FILE_EXTENSION")) {
        const parentDir = dirname(fileURLToPath(context.parentURL));
        const found = withExtension(resolvePath(parentDir, specifier));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      throw error;
    }
  }

  return nextResolve(specifier, context);
}
