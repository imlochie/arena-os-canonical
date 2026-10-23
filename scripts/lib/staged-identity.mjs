/**
 * Source-to-staged-package identity contract.
 *
 * Windows acceptance fix on 6f0be59: `desktop:e2e` (and the headless
 * acceptance) consume `desktop-package/` — but nothing guaranteed that tree
 * was staged from the CURRENT source. A generic `next build` refreshes
 * `.next` (so the route manifest showed the new library routes) while the
 * staged package stayed from an older commit — the clean Windows run then
 * hit 404s for /api/library/* exactly because the STAGED server predated
 * them. The acceptance gates now regenerate the package every run, and this
 * module makes the freshness contract explicit and enforceable:
 *
 *   - `desktop:prepare-server` stamps the staged tree with the exact source
 *     state that produced it (commit + working-tree digest).
 *   - consumers verify the stamp against the current checkout and fail
 *     LOUDLY on any mismatch — a stale package can never be silently tested.
 *
 * Identity is commit SHA plus a digest of source bytes plus `git status --porcelain`, so a
 * staged tree is rejected even when the commit matches but tracked files
 * changed since staging. Never timestamps — they prove nothing about which
 * source produced the tree.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const IDENTITY_FILE = "build-identity.json";

const REGENERATE_HINT = "regenerate it with: npm run desktop:prepare-server";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The source state a staged package must match: HEAD commit + a digest of
 * tracked/unignored file contents (build outputs are ignored because all
 * build outputs — .next, desktop-package, node_modules — are gitignored). */
export function computeSourceIdentity(root) {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const porcelain = git(root, ["status", "--porcelain"]);
  // Status alone is not source identity: two edits of an already-dirty file
  // have identical porcelain output. Include every tracked/unignored source
  // file's bytes (and deletions/symlink targets), not mtime or status labels.
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256").update(`${commit}\n${porcelain}\n`);
  for (const filename of files) {
    hash.update(`${Buffer.byteLength(filename)}:${filename}\0`);
    const full = path.join(root, filename);
    let stat;
    try { stat = lstatSync(full); }
    catch (error) { if (error.code !== "ENOENT") throw error; hash.update("deleted\0"); continue; }
    if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(full)}\0`);
    else if (stat.isFile()) hash.update(`file:${stat.mode & 0o111}:`).update(createHash("sha256").update(readFileSync(full)).digest()).update("\0");
    else hash.update("non-file\0");
  }
  const sourceDigest = hash.digest("hex");
  return { commit, sourceDigest };
}

/** Stamp the staged tree (called by desktop-prepare-server AFTER staging). */
export function writeStagedIdentity(packageRoot, root) {
  const identity = {
    schema: 1,
    tool: "desktop-prepare-server",
    ...computeSourceIdentity(root),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(packageRoot, IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

/**
 * Verify a staged package was built from the current source state.
 * Returns { ok, reason, staged, current }; never throws — an inability to
 * verify (no git, unreadable stamp, missing package) is an honest failure,
 * never a silent pass.
 */
export function verifyStagedPackage({ root, packageRoot }) {
  if (!existsSync(path.join(packageRoot, "server", "server.js"))) {
    return {
      ok: false,
      reason: `no staged package at ${packageRoot} — ${REGENERATE_HINT}`,
      staged: null,
      current: null,
    };
  }
  const stampFile = path.join(packageRoot, IDENTITY_FILE);
  if (!existsSync(stampFile)) {
    return {
      ok: false,
      reason: `staged package has no ${IDENTITY_FILE} (it predates the identity contract) — ${REGENERATE_HINT}`,
      staged: null,
      current: null,
    };
  }
  let staged = null;
  try {
    staged = JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    return {
      ok: false,
      reason: `staged ${IDENTITY_FILE} is unreadable — ${REGENERATE_HINT}`,
      staged: null,
      current: null,
    };
  }
  if (typeof staged.commit !== "string" || typeof staged.sourceDigest !== "string") {
    return {
      ok: false,
      reason: `staged ${IDENTITY_FILE} is malformed — ${REGENERATE_HINT}`,
      staged: null,
      current: null,
    };
  }
  let current = null;
  try {
    current = computeSourceIdentity(root);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot verify the current source identity (git unavailable: ${String(error instanceof Error ? error.message : error)}) — run the consumer from the git checkout that staged the package`,
      staged,
      current: null,
    };
  }
  if (staged.commit !== current.commit) {
    return {
      ok: false,
      reason: `staged package was built from commit ${staged.commit.slice(0, 10)} but the checkout is ${current.commit.slice(0, 10)} — ${REGENERATE_HINT}`,
      staged,
      current,
    };
  }
  if (staged.sourceDigest !== current.sourceDigest) {
    return {
      ok: false,
      reason: `staged package was built from this commit but tracked files changed since staging — ${REGENERATE_HINT}`,
      staged,
      current,
    };
  }
  return { ok: true, reason: "staged package matches the current source state", staged, current };
}
