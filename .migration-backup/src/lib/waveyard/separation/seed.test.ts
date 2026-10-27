/**
 * Model seeding tests — network-free: the fetcher is injected and serves
 * synthetic bytes with a known sha256. What is proven: a good download
 * installs byte-exactly (atomic rename, no temp left behind), a corrupted
 * or wrong-length download NEVER becomes the model file, an already-seeded
 * model short-circuits without touching the network, failures are honest
 * and typed, progress is reported, and concurrent seeds share one download.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { MdxModelSpec } from "./mdx";
import { findMdxModel } from "./mdx";
import { getModelFileStatus, ModelSeedError, seedModelFile, type SeedProgress } from "./seed";

/** A real spec shape whose bytes we generate in-test (the registry entry's
 *  sha/size are overridden; the mechanism under test is identical). */
async function specFor(bytes: Buffer, overrides: Partial<MdxModelSpec> = {}): Promise<MdxModelSpec> {
  const base = findMdxModel("kim_vocal_2")!;
  return {
    ...base,
    file: "model-under-test.onnx",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    ...overrides,
  };
}

function fetchServing(bytes: Buffer, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (opts.status !== undefined && opts.status !== 200) {
      return new Response("gone", { status: opts.status });
    }
    const headers = new Headers();
    if (opts.headers?.["content-length"] !== undefined) headers.set("content-length", opts.headers["content-length"]);
    else headers.set("content-length", String(bytes.length));
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  };
  return { fetchImpl, calls };
}

test("status: absent model is honestly not-present; seeded model is verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const bytes = Buffer.alloc(2_000_000, 5);
    const spec = await specFor(bytes);
    const before = await getModelFileStatus(spec, dir);
    assert.equal(before.present, false);
    assert.equal(before.verified, false);

    const { fetchImpl } = fetchServing(bytes);
    const result = await seedModelFile(spec, { dir, fetchImpl });
    assert.equal(result.outcome, "installed");

    const after = await getModelFileStatus(spec, dir);
    assert.equal(after.present, true);
    assert.equal(after.verified, true);
    assert.equal(after.sizeBytes, bytes.length);
    // The installed file is byte-identical and no temp file is left behind.
    const installed = await readFile(join(dir, spec.file));
    assert.ok(installed.equals(bytes));
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith(".download-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupted download never becomes the model file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const good = Buffer.alloc(2_000_000, 7);
    const spec = await specFor(good);
    const corrupted = Buffer.from(good);
    corrupted[100] ^= 0xff;
    const { fetchImpl } = fetchServing(corrupted);
    await assert.rejects(() => seedModelFile(spec, { dir, fetchImpl }), (err: unknown) => {
      assert.ok(err instanceof ModelSeedError);
      assert.match(err.message, /integrity check/);
      return true;
    });
    const status = await getModelFileStatus(spec, dir);
    assert.equal(status.present, false, "nothing was installed");
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith(".download-"));
    assert.deepEqual(leftovers, [], "temp removed after failed verify");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong-length response (an error page, not the model) is refused before install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const good = Buffer.alloc(2_000_000, 9);
    const spec = await specFor(good);
    const { fetchImpl } = fetchServing(Buffer.from("<html>Service Unavailable</html>"), {
      headers: { "content-length": "36" },
    });
    await assert.rejects(() => seedModelFile(spec, { dir, fetchImpl }), (err: unknown) => {
      assert.ok(err instanceof ModelSeedError);
      assert.match(err.message, /not the registered model/);
      return true;
    });
    assert.equal((await getModelFileStatus(spec, dir)).present, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP failure and network failure are honest, typed errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const bytes = Buffer.alloc(2_000_000, 3);
    const spec = await specFor(bytes);
    const { fetchImpl: failing } = fetchServing(bytes, { status: 503 });
    await assert.rejects(() => seedModelFile(spec, { dir, fetchImpl: failing }), /refused \(HTTP 503\)/);

    const offline = async () => {
      throw new Error("ENOTFOUND example.invalid");
    };
    await assert.rejects(() => seedModelFile(spec, { dir, fetchImpl: offline }), /could not downloaded[\s\S]*ENOTFOUND|could not be downloaded[\s\S]*ENOTFOUND/);
    assert.equal((await getModelFileStatus(spec, dir)).present, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("already-seeded model short-circuits without touching the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const bytes = Buffer.alloc(2_000_000, 11);
    const spec = await specFor(bytes);
    const { fetchImpl, calls } = fetchServing(bytes);
    await seedModelFile(spec, { dir, fetchImpl });
    assert.equal(calls.length, 1);

    const again = await seedModelFile(spec, {
      dir,
      fetchImpl: async () => {
        throw new Error("network must not be touched");
      },
    });
    assert.equal(again.outcome, "already-present");
    assert.equal(calls.length, 1, "no second fetch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress is reported with real byte counts; concurrent seeds share one download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const bytes = Buffer.alloc(2_000_000, 13);
    const spec = await specFor(bytes);
    const progress: SeedProgress[] = [];
    const { fetchImpl, calls } = fetchServing(bytes);
    const [a, b] = await Promise.all([
      seedModelFile(spec, { dir, fetchImpl, onProgress: (p) => progress.push(p) }),
      seedModelFile(spec, { dir, fetchImpl }),
    ]);
    assert.equal(calls.length, 1, "two concurrent seeds = one download");
    assert.equal(a.outcome, "installed");
    assert.equal(b.outcome, "installed");
    const last = progress.at(-1);
    assert.ok(last && last.bytes === bytes.length && last.totalBytes === bytes.length, "final progress is complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the seed URL is always the registry's own sourceUrl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-seed-"));
  try {
    const bytes = Buffer.alloc(2_000_000, 15);
    const spec = await specFor(bytes, { sourceUrl: "https://registry.example.org/models/model-under-test.onnx" });
    const { fetchImpl, calls } = fetchServing(bytes);
    await seedModelFile(spec, { dir, fetchImpl });
    assert.deepEqual(calls, ["https://registry.example.org/models/model-under-test.onnx"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
