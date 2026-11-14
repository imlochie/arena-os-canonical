/**
 * Static server for the listening pack, so the renders are auditionable in a
 * browser (including iOS Safari) instead of only downloadable.
 *
 * Written rather than using `python -m http.server` for one reason: iOS Safari
 * requires HTTP byte-range support to play and seek `<audio>`, and Python's
 * SimpleHTTPRequestHandler does not implement it. Range support here is the
 * difference between a player that works on a phone and one that sits at 0:00.
 *
 * Usage: node scripts/serve-listening-pack.mjs [--port 8080] [--root docs/listening-pack-v1]
 */

import { createReadStream, statSync, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const PORT = Number(flag("port", "8080"));
const ROOT = resolve(flag("root", "docs/listening-pack-v1"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
};

function listDirectory(urlPath) {
  const entries = readdirSync(join(ROOT, urlPath), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = entries.map((entry) => {
    const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
    return `<li><a href="${join(urlPath, entry.name)}">${name}</a></li>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>listening pack</title>
<style>body{background:#111318;color:#e8eaf0;font:16px/1.6 -apple-system,sans-serif;padding:20px}
a{color:#6fa8ff}li{margin:4px 0}</style>
<h1>Waveyard listening pack</h1>
<p>Open <a href="/index.html">index.html</a> to play every render.</p>
<ul>${rows}</ul>`;
}

const server = createServer((request, response) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("bad request");
    return;
  }
  // Contain traversal: normalize then confirm the resolved path stays in ROOT.
  const target = resolve(join(ROOT, normalize(urlPath)));
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  let filePath = target;
  let stats;
  try {
    stats = statSync(filePath);
    if (stats.isDirectory()) {
      if (existsSync(join(filePath, "index.html"))) {
        filePath = join(filePath, "index.html");
        stats = statSync(filePath);
      } else {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(listDirectory(urlPath));
        return;
      }
    }
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }

  const type = TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const total = stats.size;
  const range = request.headers.range;

  // Byte-range: required for iOS Safari audio playback and seeking.
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      response.writeHead(416, { "content-range": `bytes */${total}` }).end();
      return;
    }
    const start = match[1] === "" ? 0 : Number(match[1]);
    const end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
    if (start > end || start >= total) {
      response.writeHead(416, { "content-range": `bytes */${total}` }).end();
      return;
    }
    response.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=300",
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "content-type": type,
    "content-length": total,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=300",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening pack served from ${ROOT}`);
  console.log(`bound to 0.0.0.0:${PORT}`);
});
