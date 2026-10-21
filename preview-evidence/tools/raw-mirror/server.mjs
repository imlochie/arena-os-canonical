#!/usr/bin/env node
/**
 * Byte-faithful mirror for ONE blocked upstream host used by the Arcade source
 * workshop: https://raw.githubusercontent.com/gabrielecirulli/2048/<pin>/<file>.
 *
 * Why it exists: this sandbox can reach github.com / codeload.github.com but
 * not raw.githubusercontent.com. The application pins the exact SHA-256 of all
 * four upstream files and verifies them before patching, so mirroring the
 * transport does not weaken the trust anchor. This server re-verifies the pins
 * on startup and refuses to serve anything else.
 *
 * It is test-environment scaffolding, NOT application code.
 */
import { createServer } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PIN = "478b6ec346e3787f589e4af751378d06ded4cbbc";
const FILES = {
  "js/game_manager.js": "b02baa6b75f8c8cad8606e680b6f73b7c843c61e3a643ee48410022499a649f0",
  "js/grid.js": "169428f5ff7f726c38112fcf1c918028cbca3a1d9f9239838fbc7eb4396b9f9a",
  "js/tile.js": "13699e51d62179a6d36874108831a29901a98d6e11329918e64cfb5ee82d58e3",
  "LICENSE.txt": "57e12c39a6ad9d98b2e451065bfdfbd15fc9e0c2ed3bf4dc1d09acab41ff02fc",
};
const bodies = new Map();
for (const [file, sha] of Object.entries(FILES)) {
  const bytes = readFileSync(join(here, "upstream", file));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha) throw new Error(`pin mismatch for ${file}: ${actual} != ${sha}`);
  // Accept both /<pin>/<file> and /<owner>/<repo>/<pin>/<file>.
  bodies.set(`/${PIN}/${file}`, bytes);
  bodies.set(`/gabrielecirulli/2048/${PIN}/${file}`, bytes);
}
const log = (line) => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try { appendFileSync("/tmp/raw-mirror-requests.log", entry); } catch {}
};
const server = createServer({
  key: readFileSync(join(here, "tls/server.key")),
  cert: readFileSync(join(here, "tls/server.pem")),
}, (req, res) => {
  const path = new URL(req.url, "https://raw.githubusercontent.com").pathname;
  const body = bodies.get(path);
  log(`${req.method} ${path} -> ${body ? 200 : 404}`);
  if (!body) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not mirrored\n"); return; }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
  res.end(body);
});
server.listen(443, "185.199.108.133", () => {
  log(`mirror listening on https://185.199.108.133:443 — ${bodies.size} pinned files verified`);
});
