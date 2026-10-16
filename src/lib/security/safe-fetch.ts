/**
 * SSRF-safe outbound fetch for caller-influenced URLs.
 *
 * - Only http/https, no embedded credentials.
 * - The hostname is resolved and EVERY resulting address must be allowed
 *   (a name that resolves to both a public and a private address is refused).
 * - Redirects are followed manually; each hop is re-validated, capped.
 * - `policy: "public"` blocks loopback, private, link-local (incl. cloud
 *   metadata 169.254.169.254), CGNAT, multicast, reserved and unspecified
 *   ranges, plus IPv4-mapped/translated IPv6 forms.
 *   `policy: "loopback"` permits ONLY loopback destinations (local runtimes).
 *
 * Residual risk: the address is validated and then fetch() resolves again, so
 * a DNS-rebinding race between the check and the connect is not closed here.
 * Use for integrations where that residual is acceptable, or pin via an
 * undici dispatcher if that threat model applies.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfPolicy = "public" | "loopback";

export class SsrfError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

const NON_PUBLIC_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Expand an IPv6 literal to eight 16-bit groups; null when malformed. */
function expandV6(address: string): number[] | null {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1] as string);
    ip = ip.slice(0, ip.length - (v4Tail[1] as string).length) + `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(groups: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number];
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return v4(g, h); // ::ffff:a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return v4(g, h); // ::ffff:0:a.b.c.d
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return v4(g, h); // 64:ff9b::/96 NAT64
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && (g !== 0 || h > 1)) return v4(g, h); // ::a.b.c.d (deprecated)
  if (a === 0x2002) return v4(b, c); // 6to4
  return null;
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return inV4(ipv4ToInt(address), "127.0.0.0", 8);
  if (family === 6) {
    const groups = expandV6(address);
    if (groups === null) return false;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
    const mapped = embeddedV4(groups);
    return mapped !== null && inV4(ipv4ToInt(mapped), "127.0.0.0", 8);
  }
  return false;
}

/** True when the address is routable on the public internet. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) {
    const n = ipv4ToInt(bare);
    return !NON_PUBLIC_V4.some(([base, bits]) => inV4(n, base, bits));
  }
  if (family === 6) {
    const groups = expandV6(bare);
    if (groups === null) return false;
    const embedded = embeddedV4(groups);
    if (embedded !== null) return isPublicAddress(embedded);
    const first = groups[0] as number;
    if (groups.every((g) => g === 0)) return false; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation
    return (first & 0xe000) === 0x2000; // only global unicast 2000::/3
  }
  return false;
}

function addressAllowed(address: string, policy: SsrfPolicy): boolean {
  return policy === "loopback" ? isLoopbackAddress(address) : isPublicAddress(address);
}

export interface SafeUrlOptions {
  policy?: SsrfPolicy;
  lookup?: LookupFn;
}

/** Parse and validate a URL (scheme, credentials, resolved addresses). */
export async function assertSafeUrl(raw: string | URL, options: SafeUrlOptions = {}): Promise<URL> {
  const policy = options.policy ?? "public";
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SsrfError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("Only http and https URLs are allowed.");
  if (url.username !== "" || url.password !== "") throw new SsrfError("URLs with embedded credentials are not allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "") throw new SsrfError("URL has no host.");

  const literal = isIP(hostname) !== 0;
  let addresses: string[];
  if (literal) {
    addresses = [hostname];
  } else {
    if (policy === "loopback" && hostname.toLowerCase() !== "localhost") {
      throw new SsrfError("Only localhost or a loopback address is allowed.");
    }
    try {
      addresses = (await (options.lookup ?? defaultLookup)(hostname)).map((entry) => entry.address);
    } catch {
      throw new SsrfError(`Could not resolve host "${hostname}".`);
    }
    if (addresses.length === 0) throw new SsrfError(`Could not resolve host "${hostname}".`);
  }
  for (const address of addresses) {
    if (!addressAllowed(address, policy)) {
      throw new SsrfError(policy === "loopback" ? "Destination is not a loopback address." : "Destination resolves to a non-public address.");
    }
  }
  return url;
}

export interface SafeFetchOptions extends SafeUrlOptions {
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

export async function safeFetch(raw: string | URL, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  let current = await assertSafeUrl(raw, options);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current, { ...init, method, body, redirect: "manual" });
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new SsrfError("Too many redirects.");
    current = await assertSafeUrl(new URL(location, current), options);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}
