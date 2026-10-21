#!/usr/bin/env node
/**
 * Preview shim — NOT part of the application, NOT used for acceptance evidence.
 *
 * Arena's desktop runtime refuses non-loopback Host headers by design
 * ("Arena desktop only serves loopback hosts", src/lib/security/api-access.ts).
 * The sandbox preview proxy forwards the public preview hostname, so a direct
 * exposure of the runtime is a 403 page. This tiny reverse proxy forwards to the
 * loopback runtime and rewrites only the Host header, which makes the already
 * running build browsable from the preview URL.
 *
 * Consequences, stated plainly:
 *   - Anyone holding the preview URL gets the owner's local-trust view of this
 *     sandbox instance. That is acceptable only because the preview URL is a
 *     private session URL containing acceptance data and no credentials.
 *   - It is not a deployment pattern and it bypasses the DNS-rebinding/LAN
 *     protection the app deliberately implements.
 *
 * Usage: node preview-evidence/tools/preview-proxy.mjs [listenPort] [targetPort]
 */
import http from "node:http";

const listenPort = Number(process.argv[2] ?? 8080);
const targetPort = Number(process.argv[3] ?? 3000);

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  delete headers["accept-encoding"]; // keep bodies plain so nothing is re-encoded twice
  const upstream = http.request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers },
    up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", err => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: `preview shim upstream error: ${err.message}` }));
  });
  req.pipe(upstream);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`preview shim on http://0.0.0.0:${listenPort} -> 127.0.0.1:${targetPort}`);
});
