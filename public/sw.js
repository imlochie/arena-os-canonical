// ArenaForge offline shell: network-first, cache fallback for navigations.
// API routes are NEVER cached. Cache stores app shell only — no prompts,
// no responses, no personal data.
const VERSION = "arenaforge-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
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
  // Never intercept API calls or cross-origin AI/image traffic.
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
