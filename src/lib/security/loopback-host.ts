const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(hostHeader: string | null): boolean {
  if (hostHeader === null) return false;
  const value = hostHeader.trim().toLowerCase();
  if (value === "") return false;
  // Strip the port; IPv6 literals are bracketed ("[::1]:3000").
  const host = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}
