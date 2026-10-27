import { Router } from "express";
import { Readable } from "node:stream";
import { importedRoutes } from "../imported-routes";
import { isLocalMutationAllowed } from "@workspace/arena/lib/security/local-request-gate";
import { publicBattlePayload } from "../lib/blind-battle";

const router = Router();

// Retain the imported same-origin mutation gate behind Replit's trusted proxy.
router.use((req, res, next) => {
  const host = req.get("x-forwarded-host")?.split(",")[0].trim() || req.get("host") || null;
  if (!isLocalMutationAllowed({
    method: req.method, host, origin: req.get("origin") || null,
    secFetchSite: req.get("sec-fetch-site") || null,
  })) {
    res.status(403).json({ error: "Cross-origin requests cannot change local data." });
    return;
  }
  next();
});

// Existing Web Request/Response handlers are hosted by Express. Streaming
// responses, multipart bodies, byte ranges and aborts retain their semantics.
for (const route of importedRoutes) {
  router.all(route.path, async (req, res, next) => {
    if (!route.methods.includes(req.method)) { next(); return; }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const host = req.get("x-forwarded-host")?.split(",")[0].trim() || req.get("host");
      const protocol = req.get("x-forwarded-proto")?.split(",")[0].trim() || req.protocol;
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
      const request = new Request(`${protocol}://${host}${req.originalUrl}`, {
        method: req.method, headers, body, signal: abort.signal,
        ...(body ? { duplex: "half" } : {}),
      } as RequestInit);
      const handlers = await route.load();
      const response = await (handlers as any)[req.method](request, { params: Promise.resolve(req.params) });
      const beforeVote = req.path.startsWith("/battles")
        && !/\/(?:vote|reveal)$/.test(req.path)
        && req.method === "POST";
      if (response.headers.get("content-type")?.includes("application/json")) {
        const payload = publicBattlePayload(await response.json(), beforeVote);
        response.headers.forEach((value: string, key: string) => {
          if (!["content-length", "set-cookie", "content-type"].includes(key)) res.setHeader(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader("set-cookie", cookies);
        res.status(response.status).json(payload);
        return;
      }
      res.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        if (key !== "set-cookie") res.setHeader(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      if (!response.body || req.method === "HEAD") { res.end(); return; }
      Readable.fromWeb(response.body as any).on("error", next).pipe(res);
    } catch (err) {
      req.log.error({ err }, "Imported API handler failed");
      if (!res.headersSent) res.status(500).json({ error: "Request failed" });
      else res.end();
    }
  });
}

router.get("/page-data/:kind/:id", async (req, res) => {
  const loaders = {
    battles: () => import("../page-data/battles"),
    collabs: () => import("../page-data/collabs"),
    rooms: () => import("../page-data/rooms"),
  };
  const load = loaders[req.params.kind as keyof typeof loaders];
  if (!load) { res.status(404).json({ error: "Page not found" }); return; }
  try {
    const { loadPage } = await load();
    const response = await loadPage({ id: String(req.params.id), roomId: String(req.params.id) });
    res.status(response.status).json(publicBattlePayload(await response.json()));
  } catch (err) {
    req.log.error({ err }, "Page data failed");
    res.status(500).json({ error: "Could not load this page" });
  }
});
export default router;
