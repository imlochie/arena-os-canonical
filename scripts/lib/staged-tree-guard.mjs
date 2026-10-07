/**
 * Staged-server packaging guard — the staging boundary invariant.
 *
 * PROVEN DEFECT (real Windows run, commit d466321): Turbopack output file
 * tracing recursively includes repo-root directories that exist at build
 * time (any file, any depth) into `.next/standalone` unless they are listed
 * in outputFileTracingExcludes. A previous `desktop-release/win-unpacked`
 * therefore shipped INSIDE the next installer
 * (`resources/app/server/desktop-release/win-unpacked/...`) — recursive
 * self-packaging: every build swallowed the whole previous build.
 *
 * next.config.ts now excludes ./desktop-release/** and ./desktop-package/**,
 * but staging must never trust a single layer. This guard REJECTS any staged
 * tree that contains packaging output, so the failure is loud at the
 * boundary (before electron-builder ever runs), not a silent recursive cake.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

/** Directory names that must never appear anywhere inside the staged server. */
export const FORBIDDEN_DIR_NAMES = new Set([
  "desktop-release",
  "desktop-package",
  "win-unpacked",
  "linux-unpacked",
  "mac-unpacked",
]);

/**
 * Find packaging-output contamination in a staged tree.
 * Returns an array of violations (empty = clean).
 *
 * Also flags the packaged-app layout (`resources/app/...`) appearing inside
 * the staged server — the signature of a previous build's output.
 */
export function findPackagingContamination(root) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIR_NAMES.has(entry.name)) {
          violations.push({ path: full, reason: `packaging output directory "${entry.name}" inside the staged tree` });
          continue; // do not descend into a previous build's output
        }
        if (entry.name === "app" && path.basename(path.dirname(full)) === "resources") {
          violations.push({ path: full, reason: "packaged-app layout (resources/app) inside the staged tree" });
          continue;
        }
        walk(full);
      }
    }
  };
  walk(root);
  return violations;
}

/** Throw with an actionable message if the staged tree is contaminated. */
export function assertStagedTreeClean(root) {
  const violations = findPackagingContamination(root);
  if (violations.length > 0) {
    const details = violations.slice(0, 10).map((v) => `  • ${v.path} — ${v.reason}`).join("\n");
    throw new Error(
      `The staged desktop server contains packaging output — recursive self-packaging guard tripped:\n${details}\n` +
        `This means a previous build's output leaked into the staged tree (root cause: Turbopack file tracing ` +
        `sweeping repo-root directories; see next.config.ts outputFileTracingExcludes). ` +
        `Remove the contamination source and re-run npm run desktop:prepare-server.`,
    );
  }
}
