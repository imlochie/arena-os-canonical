import { encodeModPackage, parseModPackage } from "@workspace/arena/lib/mod-workshop";
import { readRepositoryFile, readRepositoryLicense, resolveRepositoryTree, RepositoryImportError } from "./repository-source";
/** Fetch a declared package at a pinned commit; never run build/install hooks. */
export async function acquireModRepository(url: string, signal: AbortSignal, read?: Parameters<typeof resolveRepositoryTree>[2]) {
  const snapshot = await resolveRepositoryTree(url, signal, read);
  const license = await readRepositoryLicense(snapshot, signal, read);
  const node = snapshot.nodes.find(node => node.path === "arcade-mod.json" && node.type === "blob" && node.mode === "100644");
  if (!node || !Number.isSafeInteger(node.size) || node.size! > 24 * 1024 * 1024) throw new RepositoryImportError("This repository needs a bounded arcade-mod.json package at its root. Generic mods cannot be guessed or executed.", 422);
  const bytes = await readRepositoryFile(snapshot.link.repository, snapshot.revision,
    { path: node.path, sha: node.sha!, size: node.size! }, signal, read, snapshot.link.provider);
  const mod = await parseModPackage(bytes.toString("utf8"));
  const sourceUrl = snapshot.link.provider === "github"
    ? `https://github.com/${snapshot.link.repository}/tree/${snapshot.revision}`
    : `https://codeberg.org/${snapshot.link.repository}/src/commit/${snapshot.revision}`;
  mod.manifest.source = { kind: "repository", url: sourceUrl, revision: snapshot.revision };
  mod.manifest.license.text += `\n\nVerified repository license (${license.spdx}, ${license.path}):\n${license.text}`;
  if (mod.manifest.license.text.length > 65536) throw new RepositoryImportError("Combined mod and repository license notices exceed the package limit.", 422);
  return { packageJson: encodeModPackage(mod) };
}
