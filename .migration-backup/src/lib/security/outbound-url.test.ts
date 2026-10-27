/**
 * Outbound URL policy tests — the adversarial cases an SSRF probe actually
 * uses: metadata endpoints, private ranges, alternate IP spellings,
 * IPv4-mapped/NAT64/6to4 embeddings, DNS answers pointing inward, and
 * redirect hops toward internal services.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OutboundUrlError,
  assertOutboundUrl,
  assertUrlDestination,
  classifyAddress,
  safeFetch,
} from "./outbound-url";

test("classifyAddress: internal ranges of every spelling are never public", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("127.1.2.3"), "loopback");
  assert.equal(classifyAddress("0.0.0.0"), "unspecified");
  assert.equal(classifyAddress("10.0.0.1"), "private");
  assert.equal(classifyAddress("172.16.0.1"), "private");
  assert.equal(classifyAddress("172.31.255.255"), "private");
  assert.equal(classifyAddress("172.32.0.1"), "public"); // outside 172.16/12
  assert.equal(classifyAddress("192.168.1.1"), "private");
  assert.equal(classifyAddress("169.254.169.254"), "link-local"); // cloud metadata
  assert.equal(classifyAddress("100.64.0.1"), "cgnat");
  assert.equal(classifyAddress("224.0.0.1"), "multicast");
  assert.equal(classifyAddress("255.255.255.255"), "reserved");
  assert.equal(classifyAddress("198.51.100.7"), "reserved"); // TEST-NET-2

  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(classifyAddress("::"), "unspecified");
  assert.equal(classifyAddress("fc00::1"), "private");
  assert.equal(classifyAddress("fd12:3456::1"), "private");
  assert.equal(classifyAddress("fe80::1"), "link-local");
  assert.equal(classifyAddress("ff02::1"), "multicast");
  assert.equal(classifyAddress("2606:4700:4700::1111"), "public");

  // Embeddings that hide an internal IPv4 inside IPv6 syntax.
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::ffff:7f00:1"), "loopback");
  assert.equal(classifyAddress("::ffff:169.254.169.254"), "link-local");
  assert.equal(classifyAddress("::ffff:10.0.0.1"), "private");
  assert.equal(classifyAddress("64:ff9b::7f00:1"), "loopback"); // NAT64 → 127.0.0.1
  assert.equal(classifyAddress("64:ff9b::a00:1"), "private"); // NAT64 → 10.0.0.1
  assert.equal(classifyAddress("2002:7f00:1::"), "loopback"); // 6to4 → 127.0.0.1
  assert.equal(classifyAddress("2002:a00:1::"), "private"); // 6to4 → 10.0.0.1
  assert.equal(classifyAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2"), "reserved"); // Teredo

  // Junk is never public.
  assert.equal(classifyAddress("not-an-address"), "reserved");
});

test("loopback policy: literals and localhost only — no DNS names", () => {
  assertUrlDestination(new URL("http://127.0.0.1:8080/health"), "loopback");
  assertUrlDestination(new URL("http://[::1]:8080/health"), "loopback");
  assertUrlDestination(new URL("http://localhost:8080/health"), "loopback");
  assertUrlDestination(new URL("http://0.0.0.0:8080/health"), "loopback");

  for (const bad of [
    "http://example.com/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5:8080/",
    "http://[fd00::1]:8080/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ]) {
    assert.throws(() => assertUrlDestination(new URL(bad), "loopback"), OutboundUrlError, bad);
  }
  // Non-http schemes are refused outright.
  assert.throws(() => assertUrlDestination(new URL("file:///etc/passwd"), "loopback"), OutboundUrlError);
  assert.throws(() => assertUrlDestination(new URL("ftp://127.0.0.1/x"), "loopback"), OutboundUrlError);
});

test("URL-parser normalised aliases of loopback are recognised (decimal, hex, short)", () => {
  // WHATWG URL parsing collapses these to 127.0.0.1 — the check runs after.
  assertUrlDestination(new URL("http://2130706433/"), "loopback");
  assertUrlDestination(new URL("http://0x7f000001/"), "loopback");
  assertUrlDestination(new URL("http://127.1/"), "loopback");
  assert.throws(() => assertUrlDestination(new URL("http://16843009/"), "loopback"), OutboundUrlError); // 1.1.1.1
});

test("public policy: metadata and internal literals are refused with the class named", () => {
  assertUrlDestination(new URL("https://example.com/audio.mp3"), "public");
  assertUrlDestination(new URL("https://93.184.216.34/audio.mp3"), "public");

  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/",
    "http://127.0.0.1:5432/",
    "http://[::1]/",
    "http://10.1.2.3/file.wav",
    "http://192.168.0.10/file.wav",
  ]) {
    assert.throws(() => assertUrlDestination(new URL(bad), "public"), OutboundUrlError, bad);
  }

  // Opt-in LAN admits RFC1918 only — metadata and loopback stay refused.
  assertUrlDestination(new URL("http://192.168.0.10/file.wav"), "public", { allowPrivate: true });
  assert.throws(() => assertUrlDestination(new URL("http://169.254.169.254/"), "public", { allowPrivate: true }), OutboundUrlError);
  assert.throws(() => assertUrlDestination(new URL("http://127.0.0.1/"), "public", { allowPrivate: true }), OutboundUrlError);
});

test("credentials embedded in URLs are refused", () => {
  assert.throws(() => assertUrlDestination(new URL("http://user:pass@127.0.0.1/"), "loopback"), OutboundUrlError);
});

test("DNS answers pointing inward refuse the whole URL (rebinding-style multi-record)", async () => {
  const url = await assertOutboundUrl("https://cdn.example.com/a.wav", "public", {
    lookup: async () => ["93.184.216.34", "127.0.0.1"], // one good, one internal
  }).then(
    () => null,
    (error) => error,
  );
  assert.ok(url instanceof OutboundUrlError);
  assert.match(url.message, /127\.0\.0\.1 is loopback/);

  const ok = await assertOutboundUrl("https://cdn.example.com/a.wav", "public", {
    lookup: async () => ["93.184.216.34"],
  });
  assert.equal(ok.hostname, "cdn.example.com");

  await assert.rejects(
    () => assertOutboundUrl("https://internal.example.com/a.wav", "public", { lookup: async () => ["10.0.0.8"] }),
    /is private/,
  );
  await assert.rejects(
    () => assertOutboundUrl("https://metadata.example.com/", "public", { lookup: async () => ["169.254.169.254"] }),
    /is link-local/,
  );
});

test("safeFetch revalidates every redirect hop", async () => {
  const hops: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    hops.push(target);
    if (hops.length === 1) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    return new Response("ok");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => safeFetch("https://start.example.com/file", {}, { policy: "public", fetchImpl, lookup: async () => ["93.184.216.34"] }),
    /link-local/,
  );
  assert.equal(hops.length, 1, "the internal redirect target must be refused before any request to it");

  // A legitimate redirect is followed after its own check.
  const hops2: string[] = [];
  const fetchImpl2 = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    hops2.push(target);
    if (hops2.length === 1) {
      return new Response(null, { status: 302, headers: { location: "https://other.example.com/final.wav" } });
    }
    return new Response("ok");
  }) as unknown as typeof fetch;
  const response = await safeFetch("https://start.example.com/file", {}, {
    policy: "public",
    fetchImpl: fetchImpl2,
    lookup: async () => ["93.184.216.34"],
  });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(hops2, ["https://start.example.com/file", "https://other.example.com/final.wav"]);

  // Redirect loops are bounded.
  let count = 0;
  const fetchImpl3 = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    count += 1;
    return new Response(null, { status: 302, headers: { location: target + "/again" } });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => safeFetch("https://loop.example.com/", {}, { policy: "public", fetchImpl: fetchImpl3, lookup: async () => ["93.184.216.34"], maxRedirects: 3 }),
    /too many redirects/,
  );
});
