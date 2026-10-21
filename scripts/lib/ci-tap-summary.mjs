/** Make failed test identities available via GitHub's check annotations even
 * when this host cannot fetch signed Actions log/artifact storage URLs.
 * Deliberately excludes stdout/error bodies, which may contain private data. */
export function tapFailureAnnotations(tap) {
  const names = [...new Set([...tap.matchAll(/^\s*not ok \d+\s*-\s*(.+)$/gm)].map((match) => match[1].trim()))];
  const escape = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return names.slice(0, 20).map((name) => `::error title=Test failure::${escape(name.slice(0, 500))} — see retained TAP for assertions and outputs.`);
}
