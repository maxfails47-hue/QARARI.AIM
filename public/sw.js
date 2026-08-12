// Qarari.AI service worker — minimal & safe.
// Goals:
// 1. Make the app installable or a proper PWA (a registered SW is required).
// 2. Speed up repeat visits by caching the static app shell (JS/CSS/icons).
// 3. NEVER cache /api/* responses — analysis, chat, prices, and auth must
//    always be fresh and live; caching them would produce stale or wrong
//    financial/AI results, which is far worse than a slightly slower load.

const CACHE_NAME = "qarari-shell-v2";
const APP_SHELL = ["/", "/manifest.json", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never touch API calls — always go straight to the network.
  if (url.pathname.startsWith("/api/")) return;

  // Cross-origin requests (Supabase, Groq, etc.) — let the browser handle them.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      // Stale-while-revalidate: serve cache instantly if we have it, refresh in background.
      return cached || network;
    })
  );
});
