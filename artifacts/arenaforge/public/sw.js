// ArenaForge offline shell and the pinned EmulatorJS runtime only.
// API routes, prompts, responses, and imported ROMs are never cached here.
const VERSION = "arenaforge-v2";
const EMULATORJS_ORIGIN = "https://cdn.emulatorjs.org";
const EMULATORJS_PATH = "/4.2.3/data/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("arenaforge-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const isPinnedEmulatorAsset = url.origin === EMULATORJS_ORIGIN &&
    url.pathname.startsWith(EMULATORJS_PATH) &&
    (!url.pathname.includes("/cores/") || url.pathname.includes("/cores/reports/"));
  if (isPinnedEmulatorAsset) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const response = await fetch(req);
          if (response.ok || response.type === "opaque") {
            await cache.put(req, response.clone()).catch(() => {});
          }
          return response;
        } catch {
          return new Response("EmulatorJS runtime is not cached yet. Connect once and start this game to download it.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })
    );
    return;
  }
  // Never intercept API calls or unrelated cross-origin traffic.
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches
            .open(VERSION)
            .then((cache) => cache.put(req, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (hit) =>
            hit ||
            caches.match("/").then(
              (home) =>
                home ||
                new Response("Offline — open the app once while online to cache it.", {
                  status: 503,
                  headers: { "Content-Type": "text/plain" },
                })
            )
        )
      )
  );
});
