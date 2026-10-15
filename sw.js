/*
 * WRS GEMPA service worker
 * - Offline navigation uses a dedicated cached status screen.
 * - App assets use network-first with a cache fallback.
 * - API requests remain network-only; cached earthquake data is handled by the app itself.
 * - Push notification handling is preserved.
 */
const CACHE_NAME = "wrs-gempa-shell-v10-0-1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/offline.html",
  "/styles.css?v=20261013-11",
  "/ui-refresh.css",
  "/app.js?v=20261015-4",
  "/ai-chat.js?v=20261014-2",
  "/ai-chat.css?v=20261014-4",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache each item independently so a single missing asset cannot cancel the
    // whole offline shell installation. offline.html is the essential fallback.
    await Promise.all(APP_SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: "reload" });
        if (response.ok) await cache.put(path, response);
      } catch (error) {
        console.warn("[WRS SW] App shell item not cached:", path, String(error?.message || error));
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith("wrs-gempa-shell-") && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cachedOfflinePage() {
  return (await caches.match("/offline.html")) || new Response(
    "<!doctype html><html lang=\"id\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WRS GEMPA offline</title><body style=\"font-family:system-ui;background:#06101d;color:#eef8ff;padding:32px\"><h1>WRS GEMPA · Koneksi terputus</h1><p>Server belum dapat dijangkau. Coba kembali saat koneksi pulih.</p></body></html>",
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API remains network-only. Never cache a temporary failure as fresh data.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ ok: false, error: "network_unavailable" }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    )));
    return;
  }

  // Navigation: display the branded offline screen rather than a browser network error.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          const copy = response.clone();
          event.waitUntil((async () => {
            await cache.put(request, copy);
            if (url.pathname === "/") await cache.put("/index.html", response.clone());
          })());
          return response;
        }
        return await cachedOfflinePage();
      } catch (_) {
        return await cachedOfflinePage();
      }
    })());
    return;
  }

  // Script/style/manifest requests are network-first, with query-insensitive cache fallback.
  if (["/app.js", "/styles.css", "/ui-refresh.css", "/manifest.json", "/ai-chat.js", "/ai-chat.css"].includes(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          event.waitUntil(cache.put(request, response.clone()));
        }
        return response;
      } catch (_) {
        const cached = await caches.match(request) || await caches.match(request, { ignoreSearch: true });
        return cached || new Response("", { status: 503, headers: { "cache-control": "no-store" } });
      }
    })());
    return;
  }

  // Local images/icons are cache-first after their first successful request.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        event.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    } catch (_) {
      return new Response("", { status: 503, headers: { "cache-control": "no-store" } });
    }
  })());
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Pantau Gempa", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Pantau Gempa";
  const magnitude = Number(data.magnitude || 0);
  const urgent = Boolean(data.tsunami) || magnitude >= 6.5;
  const options = {
    body: data.body || "Ada gempa baru terdeteksi.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    vibrate: urgent ? [500, 120, 500, 120, 900, 150, 900] : magnitude >= 5 ? [350, 120, 350, 120, 500] : [180, 100, 180],
    tag: `gempa-${data.key || data.time || Date.now()}`,
    renotify: true,
    requireInteraction: urgent,
    timestamp: data.time ? new Date(data.time).getTime() : Date.now(),
    data: { url: data.url || "/", key: data.key || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        if ("navigate" in client && client.url !== targetUrl) return client.navigate(targetUrl);
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  }));
});
