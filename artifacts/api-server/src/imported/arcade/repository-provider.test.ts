import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { lookup } from "node:dns/promises";
import type { request } from "node:https";
import { assessCodebergRepository, assessSourceForgeRepository } from "./repository-assessment";
import {
  acquireRepository, createCodebergReader, createSourceForgeReader, inspectRepository, parseRepositoryLink,
} from "./repository-source";

const revision = "b".repeat(40);
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const index = Buffer.from("<!doctype html><html><body><canvas></canvas><script src=\"game.js\"></script></body></html>");
const game = Buffer.from("document.querySelector('canvas').width = 160;");
const license = Buffer.from(`MIT License

Copyright (c) 2026 Example Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`);
const codebergFiles = new Map([
  ["index.html", index], ["game.js", game], ["LICENSE", license],
]);
function codebergRead(files = codebergFiles) {
  const calls: string[] = [];
  const tree = [...files].map(([path, bytes]) =>
    ({ path, type: "blob", mode: "100644", size: bytes.length, sha: blobSha(bytes) }));
  const read = async (url: string, limit: number) => {
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "codeberg.org");
    assert.ok(parsed.pathname.startsWith("/api/v1/repos/"));
    let data: unknown;
    if (parsed.pathname === "/api/v1/repos/demo/game") data = { private: false, archived: false, default_branch: "main" };
    else if (parsed.pathname.endsWith("/branches/main")) data = { commit: { id: revision } };
    else if (parsed.pathname.endsWith(`/git/commits/${revision}`)) data = { sha: revision };
    else if (parsed.pathname.endsWith(`/git/trees/${revision}`)) data = { tree, truncated: false };
    else if (parsed.pathname.endsWith("/releases")) data = [];
    else if (parsed.pathname.includes("/contents/")) {
      const path = decodeURIComponent(parsed.pathname.split("/contents/")[1]);
      const bytes = files.get(path);
      assert.ok(bytes, `unexpected path ${path}`);
      data = { type: "file", path, sha: blobSha(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
    } else assert.fail(`unexpected Codeberg request: ${url}`);
    const bytes = Buffer.from(JSON.stringify(data));
    assert.ok(bytes.length <= limit, `response exceeded reader limit: ${url}`);
    return bytes;
  };
  return { calls, read };
}

const signal = () => AbortSignal.timeout(10_000);

test("Codeberg links resolve to immutable commits and verified files enter the offline browser importer", async () => {
  assert.deepEqual(parseRepositoryLink("https://codeberg.org/demo/game/src/commit/" + revision + "/subgame"), {
    provider: "codeberg", repository: "demo/game", ref: revision, refType: "commit", folder: "subgame/",
  });
  assert.throws(() => parseRepositoryLink("https://codeberg.org.evil/demo/game"), /other hosts/i);
  assert.throws(() => parseRepositoryLink("https://codeberg.org/demo/game/src/branch/main/%2e%2e/private"), /invalid|supported/i);

  const f = codebergRead();
  const assessment = await assessCodebergRepository("https://codeberg.org/demo/game", signal(), f.read);
  assert.equal(assessment.provider, "codeberg");
  assert.equal(assessment.revision, revision);
  assert.equal(assessment.sourceUrl, `https://codeberg.org/demo/game/src/commit/${revision}`);
  assert.equal(assessment.projectType, "browser");
  assert.equal(assessment.license?.spdx, "MIT");
  assert.equal(assessment.blockers.length, 0);

  const plan = await inspectRepository("https://codeberg.org/demo/game", signal(), f.read);
  assert.equal(plan.provider, "codeberg");
  assert.equal(plan.entryPath, "index.html");
  const acquired = await acquireRepository(plan, signal(), f.read);
  assert.equal(acquired.provenance.sourceUrl, `https://codeberg.org/demo/game/src/commit/${revision}`);
  assert.deepEqual(acquired.files.map(file => file.path).sort(), ["LICENSE", "game.js", "index.html"]);
  assert.ok(f.calls.every(url => new URL(url).hostname === "codeberg.org"));
});

test("Codeberg working-state warnings are surfaced during review and stop a bypass import", async () => {
  const files = new Map(codebergFiles);
  files.set("README.md", Buffer.from("# Project\nThis repository is currntly NOT in a working state."));
  const f = codebergRead(files);
  const assessment = await assessCodebergRepository("https://codeberg.org/demo/game", signal(), f.read);
  assert.ok(assessment.blockers.some(message => /not in a working state/i.test(message)));
  assert.ok(assessment.evidence.some(item => item.path === "README.md"));
  await assert.rejects(inspectRepository("https://codeberg.org/demo/game", signal(), f.read), /not in a working state/i);
});

test("Codeberg review recognizes complete AGPL v3 structure and the standard single-quoted Zlib notice", async () => {
  const agpl = Buffer.from(`GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007
Preamble
TERMS AND CONDITIONS
0. Definitions
1. Source Code.
13. Remote Network Interaction; Use with the GNU General Public License.
14. Revised Versions of this License.
END OF TERMS AND CONDITIONS
How to Apply These Terms to Your New Programs`);
  const files = new Map(codebergFiles);
  files.delete("LICENSE");
  files.set("COPYING", agpl);
  const assessment = await assessCodebergRepository("https://codeberg.org/demo/game", signal(), codebergRead(files).read);
  assert.deepEqual(
    { spdx: assessment.license?.spdx, path: assessment.license?.path },
    { spdx: "AGPL-3.0", path: "COPYING" },
  );

  const zlibFiles = new Map(codebergFiles);
  zlibFiles.set("LICENSE", Buffer.from(`Copyright (c) 2020 Example

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented.
2. Altered source versions must be plainly marked as such.
3. This notice may not be removed or altered from any source distribution.`));
  const zlib = await assessCodebergRepository("https://codeberg.org/demo/game", signal(), codebergRead(zlibFiles).read);
  assert.equal(zlib.license?.spdx, "Zlib");
});

test("SourceForge review matches publisher SHA-256 and keeps unlicensed, uninspected archives review-only", async () => {
  const feed = `<?xml version="1.0"?>
    <rss><channel><item>
      <title><![CDATA[/blockout/BlockOut 2.5/bl25-src.tar.gz]]></title>
      <link>https://sourceforge.net/projects/blockout/files/blockout/BlockOut%202.5/bl25-src.tar.gz/download</link>
      <pubDate>Tue, 06 May 2014 10:05:26 UT</pubDate>
      <files:sf-file-id>12530023</files:sf-file-id>
      <media:content type="application/gzip" filesize="479743">
        <media:hash algo="md5">c68a6d6f1f42aa61dbce84b100f19351</media:hash>
      </media:content>
    </item></channel></rss>`;
  const sourceforgeSha = "b".repeat(64);
  const fileIndex = `<script>net.sf.files = ${JSON.stringify({
    "bl25-src.tar.gz": {
      name: "bl25-src.tar.gz",
      full_path: "blockout/BlockOut 2.5/bl25-src.tar.gz",
      download_url: "https://sourceforge.net/projects/blockout/files/blockout/BlockOut%202.5/bl25-src.tar.gz/download",
      md5: "c68a6d6f1f42aa61dbce84b100f19351",
      sha256: sourceforgeSha,
    },
  })}; net.sf.staging_days = 3;</script>`;
  const requested: string[] = [];
  const assessment = await assessSourceForgeRepository(
    "https://sourceforge.net/projects/blockout/files/blockout/BlockOut%202.5",
    signal(),
    async (url, limit) => {
      requested.push(url);
      const content = url.includes("/rss?") ? feed : fileIndex;
      assert.ok(Buffer.byteLength(content) <= limit);
      return Buffer.from(content);
    },
  );
  assert.equal(new URL(requested[0]).searchParams.get("path"), "/blockout/BlockOut 2.5");
  assert.match(requested[1], /\/projects\/blockout\/files\/blockout\/BlockOut%202\.5\/$/);
  assert.equal(assessment.provider, "sourceforge");
  assert.equal(assessment.repository, "sourceforge/blockout");
  assert.match(assessment.revision, /^sf-files-[a-f0-9]{64}$/);
  assert.equal(assessment.reference, "BlockOut 2.5");
  assert.equal(assessment.license, null);
  assert.equal(assessment.releases[0].tag, "BlockOut 2.5");
  assert.equal(assessment.releases[0].assets[0].sha256, sourceforgeSha);
  assert.match(assessment.evidence.map(item => item.detail).join(" "), /SHA-256 was matched against the official SourceForge directory index/i);
  assert.doesNotMatch(assessment.blockers.join(" "), /No matching provider-owned SHA-256/);
  assert.match(assessment.blockers.join(" "), /license text/i);
  assert.match(assessment.blockers.join(" "), /archive-content preflight/i);
  assert.match(assessment.releases[0].reviewUrl, /\/files\/blockout\/BlockOut%202\.5$/);

  const mismatched = await assessSourceForgeRepository(
    "https://sourceforge.net/projects/blockout/files/blockout/BlockOut%202.5",
    signal(),
    async url => Buffer.from(url.includes("/rss?") ? feed : fileIndex.replace("c68a6d6f1f42aa61dbce84b100f19351", "a".repeat(32))),
  );
  assert.equal(mismatched.releases[0].assets[0].sha256, null, "a path match without the RSS digest match is not accepted");
  assert.match(mismatched.evidence.map(item => item.detail).join(" "), /RSS MD5/);
  assert.match(mismatched.blockers.join(" "), /No matching provider-owned SHA-256/);

  let fetched = false;
  await assert.rejects(assessSourceForgeRepository("https://sourceforge.net.evil/projects/blockout", signal(), async () => {
    fetched = true;
    return Buffer.from(feed);
  }), /sourceforge\.net project and files links/i);
  assert.equal(fetched, false);
  await assert.rejects(assessSourceForgeRepository(
    "https://sourceforge.net/projects/blockout/files/blockout/BlockOut%202.5",
    signal(),
    async () => Buffer.from(`<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item>&x;</item></channel></rss>`),
  ), /DTD and entity declarations/i);
});

test("Codeberg and SourceForge readers keep exact provider hosts and reject redirects", async () => {
  const makeRequest = (status: number): typeof request => ((url: URL, options: any, callback: (response: any) => void) => {
    options.lookup(url.hostname, { all: true }, (_error: unknown, rows: unknown) =>
      assert.deepEqual(rows, [{ address: "140.82.112.5", family: 4 }]));
    const req = new EventEmitter() as any;
    req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough() as any;
      response.statusCode = status;
      response.headers = {};
      callback(response);
      if (status === 200) response.end(Buffer.from("<rss/>"));
    });
    return req;
  }) as unknown as typeof request;
  const dns = (async () => [{ address: "140.82.112.5", family: 4 }]) as unknown as typeof lookup;

  const codeberg = createCodebergReader(dns, makeRequest(302));
  await assert.rejects(codeberg(`https://codeberg.org/api/v1/repos/demo/game`, 100, signal()), /redirect/i);
  await assert.rejects(codeberg(`https://codeberg.org/demo/game/raw/commit/${revision}/index.html`, 100, signal()), /unsafe/i);

  const sourceforge = createSourceForgeReader(dns, makeRequest(302));
  await assert.rejects(sourceforge("https://sourceforge.net/projects/demo/rss?path=%2F", 100, signal()), /redirect/i);
  await assert.rejects(sourceforge("https://downloads.sourceforge.net/project/demo/file.zip", 100, signal()), /unsafe/i);
  const listing = createSourceForgeReader(dns, makeRequest(200));
  await listing("https://sourceforge.net/projects/demo/files/demo/releases/v1/", 100, signal());
  await assert.rejects(listing("https://sourceforge.net/projects/demo/files/demo/%2e%2e%2fprivate/", 100, signal()), /unsafe/i);
});
