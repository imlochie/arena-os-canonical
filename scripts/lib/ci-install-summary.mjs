/** Dependency preparation diagnostics for Checks when signed log/artifact hosts
 * are unreachable. Deliberately excludes raw output, commands, URLs and paths. */
export function installFailureAnnotation(text, knownPackages = []) {
  const codes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EACCES", "EPERM", "ENOSPC", "ENOENT", "ENOTEMPTY", "EEXIST", "ELIFECYCLE", "ERESOLVE", "EUSAGE", "EINTEGRITY", "EBADENGINE"];
  const rawCode = /^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/m.exec(text)?.[1];
  const code = rawCode && (codes.includes(rawCode) || /^\d{1,3}$/.test(rawCode)) ? rawCode : "unknown";
  const transport = codes.slice(0, 5).find(value => new RegExp(`\\b${value}\\b`).test(text)) ?? "unknown";
  const packageMatch = /^npm (?:error|ERR!) path (.+)$/m.exec(text)?.[1]?.replaceAll("\\", "/").split("/node_modules/").at(-1)?.trim();
  const name = knownPackages.includes(packageMatch) ? packageMatch : "unknown";
  return `::notice title=Dependency preparation failure::npm ci failed before product acceptance; package=${name}; exitCode=${code}; transport=${transport}. Product tests did not start. Full install output retained in npm-ci.log; this notice is not a passing receipt.`;
}
