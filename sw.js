/*
 * Pantau Gempa Service Worker
 * - Push notification background
 * - Cache app shell untuk startup/offline fallback
 * - Network-first untuk HTML/JS/CSS agar data dan kode tetap mudah diperbarui
 */

const CACHE_NAME = "wrs-gempa-shell-v8-0-4";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/ui-refresh.css",
  "/app.js?v=20261012-2",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn("App shell cache gagal:", err))
      .finally(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("wrs-gempa-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API data gempa selalu network-first dan tidak masuk cache app-shell.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ ok: false, error: "network_unavailable" }),
        { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
      ))
    );
    return;
  }

  // HTML/JS/CSS/manifest: network-first, cache fallback saat jaringan bermasalah.
  if (
    request.mode === "navigate" ||
    url.pathname === "/app.js" ||
    url.pathname === "/styles.css" ||
    url.pathname === "/ui-refresh.css" ||
    url.pathname === "/manifest.json"
  ) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(url.pathname === "/app.js" ? "/app.js?v=20261012-2" : request) || caches.match("/index.html")))
    );
    return;
  }

  // Asset lokal lain: cache-first lalu simpan hasil jaringan.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener("push", (event) => {
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
    data: { url: data.url || "/", key: data.key || null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.focus().then(() => {
            if ("navigate" in client && client.url !== targetUrl) return client.navigate(targetUrl);
          });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
