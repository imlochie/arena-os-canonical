/**
 * Outbound URL policy — the single gate for every server-side fetch of a
 * caller-controlled URL (agent tools, health probes, media acquisition,
 * yt-dlp ingestion).
 *
 * Threat model: a local-first app that fetches attacker-influenced URLs
 * becomes an SSRF proxy into loopback services (the app's own API, the
 * embedded PostgreSQL, dev servers), link-local cloud metadata
 * (169.254.169.254), and private LAN hosts. DNS-based attacks matter:
 * a public-looking hostname can resolve to an internal address (DNS
 * rebinding / rebinding-style multi-record answers), and IP literals have
 * many textual aliases (decimal, hex, short, IPv4-mapped IPv6, NAT64,
 * 6to4).
 *
 * Policy (enforced on the URL Node's parser normalised, then on every DNS
 * answer, then again on every redirect hop):
 *
 *   "loopback" — only local endpoints (model hubs, health probes of
 *     user-configured local runtimes). Hostname must be a loopback/
 *     unspecified IP literal or `localhost`; no DNS is consulted, so
 *     rebinding cannot apply.
 *   "public" — only internet endpoints (authorized media sources, yt-dlp).
 *     Every resolved address must be globally routable; loopback, private,
 *     link-local (cloud metadata), CGNAT, multicast and reserved ranges are
 *     refused, including their IPv4-mapped/NAT64/6to4 spellings.
 *
 * `allowPrivate` (opt-in, e.g. MODEL_HUB_ALLOW_LAN) additionally admits
 * RFC1918 private ranges — never loopback, never link-local.
 *
 * Known residual risk (documented, not hidden): for child-process fetchers
 * (yt-dlp) the initial destination is validated but redirects inside the
 * tool are not revalidated; and for in-process fetch a hostile DNS answer
 * that changes between our lookup and the connection is not pinned. Both
 * require the caller to already control a destination that passed policy.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressClass =
  | "loopback"
  | "unspecified"
  | "private"
  | "link-local"
  | "cgnat"
  | "multicast"
  | "reserved"
  | "public";

export type OutboundPolicy = "loopback" | "public";

export interface OutboundCheckOptions {
  /** Also admit RFC1918 private ranges (never loopback/link-local). */
  allowPrivate?: boolean;
  /** DNS resolver override (tests). */
  lookup?: (hostname: string) => Promise<string[]>;
}

export class OutboundUrlError extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`Outbound URL refused (${reason}): ${url}`);
    this.name = "OutboundUrlError";
    this.url = url;
  }
}

// --------------------------- IP classification ---------------------------

function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "reserved";
  const [a, b] = parts;
  if (a === 127) return "loopback";
  if (a === 0) return ip === "0.0.0.0" ? "unspecified" : "reserved";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // cloud metadata lives here
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 192 && b === 0) return "reserved"; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0) return "reserved"; // TEST-NET-3
  return "public";
}

/** Expand an IPv6 literal to eight 16-bit groups. Accepts the optional
 *  dotted-quad tail (`::ffff:127.0.0.1`). Returns null on junk. */
function expandIPv6(host: string): number[] | null {
  let ip = host.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (isIP(ip) !== 6) return null;

  let tail: number[] | null = null;
  const lastColon = ip.lastIndexOf(":");
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = maybeV4.split(".").map((p) => Number.parseInt(p, 10));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] =>
    side === "" ? [] : side.split(":").map((g) => Number.parseInt(g, 16));
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = halves.length === 2 ? [...left, ...new Array<number>(fill).fill(0), ...right] : left;
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  if (tail !== null) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function classifyIPv4Words(hi: number, lo: number): AddressClass {
  return classifyIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
}

function classifyIPv6(host: string): AddressClass {
  const g = expandIPv6(host);
  if (g === null) return "reserved"; // unparseable → never "public"
  const allZero = g.every((n) => n === 0);

  // :: and ::1 first — they are special, not "IPv4-compatible".
  if (allZero) return "unspecified";
  if (g[7] === 1 && g.slice(0, 7).every((n) => n === 0)) return "loopback";

  // IPv4-mapped ::ffff:a.b.c.d → 0:0:0:0:0:ffff:XXXX:XXXX
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return classifyIPv4Words(g[6], g[7]);
  }
  // IPv4-translated ::ffff:0:a.b.c.d → 0:0:0:0:ffff:0:XXXX:XXXX
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
    return classifyIPv4Words(g[6], g[7]);
  }
  // Deprecated IPv4-compatible ::a.b.c.d — classify by the embedded IPv4.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return classifyIPv4Words(g[6], g[7]);
  }
  // NAT64 well-known prefix 64:ff9b::/96 (and local-use 64:ff9b:1::/48):
  if (g[0] === 0x64 && g[1] === 0xff9b && (g[2] === 0 || (g[2] === 1 && g[3] === 0))) {
    return classifyIPv4Words(g[6], g[7]);
  }
  // 6to4 2002::/16 embeds the IPv4 destination in groups 1-2.
  if (g[0] === 0x2002) return classifyIPv4Words(g[1], g[2]);
  // Teredo 2001:0::/32 embeds (obfuscated) IPv4 — never treat as public.
  if (g[0] === 0x2001 && g[1] === 0) return "reserved";

  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // unique-local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  return "public";
}

export function classifyAddress(address: string): AddressClass {
  const bare = address.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(bare);
  if (version === 4) return classifyIPv4(bare);
  if (version === 6) return classifyIPv6(bare);
  return "reserved"; // hostnames are decided via DNS, not here
}

// --------------------------- policy checks -------------------------------

function classAllowed(cls: AddressClass, policy: OutboundPolicy, allowPrivate: boolean): boolean {
  if (policy === "loopback") return cls === "loopback" || cls === "unspecified";
  if (cls === "public") return true;
  if (allowPrivate && cls === "private") return true;
  return false;
}

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * Synchronous destination check for IP-literal hostnames (and `localhost`
 * under the loopback policy). Non-IP hostnames under "public" require DNS
 * and therefore `assertOutboundUrl`. Throws OutboundUrlError when refused.
 */
export function assertUrlDestination(url: URL, policy: OutboundPolicy, options: OutboundCheckOptions = {}): URL {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError(url.toString(), "only http(s) URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundUrlError(url.toString(), "credentials in URLs are not accepted");
  }

  if (policy === "loopback") {
    // No DNS, ever: a name that "resolves to loopback today" is exactly the
    // rebinding case. Literal addresses or `localhost` only.
    if (LOCAL_NAMES.has(host)) return url;
    const cls = classifyAddress(host);
    if (isIP(host) !== 0 && classAllowed(cls, policy, false)) return url;
    throw new OutboundUrlError(url.toString(), "only loopback endpoints (127.0.0.1, ::1, localhost) are allowed");
  }

  // "public": IP literals are decided immediately; names need DNS.
  if (isIP(host) !== 0) {
    const cls = classifyAddress(host);
    if (!classAllowed(cls, policy, options.allowPrivate ?? false)) {
      throw new OutboundUrlError(url.toString(), `destination address is ${cls}, not a public endpoint`);
    }
    return url;
  }
  return url; // hostname → DNS phase
}

async function resolveAll(host: string, options: OutboundCheckOptions): Promise<string[]> {
  const custom = options.lookup;
  if (custom) return custom(host);
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Full check: URL syntax + policy on the literal (if any) + policy on EVERY
 * DNS answer (a name is only allowed if all of its addresses pass — one
 * internal answer in a multi-record response refuses the whole URL).
 */
export async function assertOutboundUrl(
  raw: string | URL,
  policy: OutboundPolicy,
  options: OutboundCheckOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw.trim()) : new URL(raw.toString());
  } catch {
    throw new OutboundUrlError(String(raw), "not a valid URL");
  }
  assertUrlDestination(url, policy, options);

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (policy === "public" && isIP(host) === 0) {
    let addresses: string[];
    try {
      addresses = await resolveAll(host, options);
    } catch (error) {
      throw new OutboundUrlError(url.toString(), `DNS resolution failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (addresses.length === 0) throw new OutboundUrlError(url.toString(), "DNS returned no addresses");
    for (const address of addresses) {
      const cls = classifyAddress(address);
      if (!classAllowed(cls, policy, options.allowPrivate ?? false)) {
        throw new OutboundUrlError(url.toString(), `DNS address ${address} is ${cls}, not a public endpoint`);
      }
    }
  }
  return url;
}

// --------------------------- safe fetch ----------------------------------

export interface SafeFetchOptions extends OutboundCheckOptions {
  policy: OutboundPolicy;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

/**
 * fetch() for caller-controlled URLs: destination-checked, redirect hops
 * revalidated (Location is checked with the same policy before following),
 * bounded redirects, optional timeout. Returns the final non-redirect
 * response.
 */
export async function safeFetch(raw: string | URL, init: RequestInit = {}, options: SafeFetchOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let target = await assertOutboundUrl(raw, options.policy, options);
  for (let hop = 0; ; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(target.toString(), { ...init, redirect: "manual", signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new OutboundUrlError(target.toString(), `request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return response;
      if (hop >= maxRedirects) throw new OutboundUrlError(target.toString(), `too many redirects (>${maxRedirects})`);
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new OutboundUrlError(target.toString(), `redirect to invalid URL: ${location}`);
      }
      target = await assertOutboundUrl(next, options.policy, options);
      continue;
    }
    return response;
  }
}
