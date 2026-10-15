/*
 * WRS GEMPA shared event stream.
 *
 * A single Durable Object polls the already-cached public API only while at
 * least one client is connected, then broadcasts small SSE change notices.
 * FCM remains independent and continues to deliver background notifications.
 */
const API_URL = "https://wrs-gempa-final.pages.dev/api/earthquakes";
const POLL_INTERVAL_MS = 15_000;
const MAX_CLIENTS = 500;

const json = (value, status = 200, extraHeaders = {}) => new Response(
  JSON.stringify(value),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  }
);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "accept, cache-control",
          "access-control-max-age": "86400"
        }
      });
    }

    if (url.pathname !== "/events" && url.pathname !== "/health") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
    }

    const id = env.WRS_STREAM.idFromName("wrs-gempa-global");
    const stub = env.WRS_STREAM.get(id);
    const internalPath = url.pathname === "/health" ? "/stats" : "/events";
    const upstream = await stub.fetch(new Request("https://wrs-stream.internal" + internalPath, {
      method: "GET",
      headers: {
        "last-event-id": request.headers.get("last-event-id") || ""
      }
    }));

    const headers = new Headers(upstream.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, OPTIONS");
    headers.set("access-control-max-age", "86400");
    headers.append("vary", "Origin");
    if (url.pathname === "/events") {
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("cache-control", "no-cache, no-transform");
      headers.set("x-accel-buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

export class WrsEarthquakeStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.polling = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (url.pathname === "/stats") {
      return json({
        ok: true,
        activeClients: this.clients.size,
        pollIntervalMs: POLL_INTERVAL_MS,
        lastPollAt: await this.state.storage.get("lastPollAt") || null,
        lastSuccessfulPollAt: await this.state.storage.get("lastSuccessfulPollAt") || null,
        version: await this.state.storage.get("version") || 0
      });
    }
    if (url.pathname !== "/events") return json({ ok: false, error: "not_found" }, 404);
    if (this.clients.size >= MAX_CLIENTS) {
      return json({ ok: false, error: "stream_capacity_reached" }, 503, { "retry-after": "10" });
    }

    const currentVersion = Number(await this.state.storage.get("version")) || 0;
    let activeController = null;
    const stream = new ReadableStream({
      start: controller => {
        activeController = controller;
        this.clients.add(controller);
        this.enqueue(controller, "retry: 5000\n: connected\n\n");
        this.enqueue(controller, "id: " + currentVersion + "\nevent: ready\ndata: " +
          JSON.stringify({ connected: true, version: currentVersion }) + "\n\n");
        this.ensureAlarm().catch(error => {
          console.warn("[WRS stream] Unable to schedule first poll:", String(error?.message || error).slice(0, 120));
        });
      },
      cancel: () => {
        if (activeController) this.clients.delete(activeController);
        activeController = null;
        this.stopIfIdle().catch(() => {});
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no"
      }
    });
  }

  enqueue(controller, chunk) {
    try {
      controller.enqueue(new TextEncoder().encode(chunk));
      return true;
    } catch (_) {
      this.clients.delete(controller);
      return false;
    }
  }

  broadcast(eventName, data, eventId) {
    const idLine = Number.isFinite(Number(eventId)) ? "id: " + Number(eventId) + "\n" : "";
    const frame = idLine + "event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const controller of [...this.clients]) this.enqueue(controller, frame);
  }

  heartbeat() {
    for (const controller of [...this.clients]) this.enqueue(controller, ": heartbeat\n\n");
  }

  async ensureAlarm() {
    if (this.clients.size === 0) return;
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null) await this.state.storage.setAlarm(Date.now() + 500);
  }

  async stopIfIdle() {
    if (this.clients.size === 0) await this.state.storage.deleteAlarm();
  }

  async alarm() {
    if (this.clients.size === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    try {
      await this.refreshFeed();
    } catch (error) {
      console.warn("[WRS stream] Feed refresh failed:", String(error?.message || error).slice(0, 140));
      this.broadcast("health", { ok: false, checkedAt: new Date().toISOString() });
    } finally {
      this.heartbeat();
      if (this.clients.size > 0) {
        await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      } else {
        await this.state.storage.deleteAlarm();
      }
    }
  }

  async refreshFeed() {
    if (this.polling) return;
    this.polling = true;
    const now = Date.now();
    try {
      const response = await fetch(API_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache"
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error("Earthquake API HTTP " + response.status);
      const payload = await response.json();
      if (payload?.ok !== true || !Array.isArray(payload.recent) ||
          !Array.isArray(payload.realtimeEvents) || !Array.isArray(payload.tsunamiHistory)) {
        throw new Error("Earthquake API response contract is invalid");
      }

      // Ignore timestamps that change on each refresh. Only catalogue, realtime,
      // tsunami archive, or source-health changes should wake all connected clients.
      const compact = event => [
        event?.key || event?.id || "",
        event?.time || "",
        event?.magnitude ?? event?.mag ?? "",
        event?.depth ?? "",
        event?.lat ?? "",
        event?.lon ?? "",
        event?.place || "",
        event?.source || "",
        event?.official === true,
        event?.isTsunamiWarning === true,
        event?.status || ""
      ];
      const sources = payload.sources || {};
      const signature = JSON.stringify({
        recent: payload.recent.map(compact),
        realtime: payload.realtimeEvents.map(compact),
        tsunamiHistory: payload.tsunamiHistory.map(compact),
        sources: {
          wrs: sources.wrs?.ok === true,
          public: sources.public === true,
          usgs: Number(sources.usgs) || 0,
          usgsGlobal: Number(sources.usgsGlobal) || 0,
          tsunami: Number(sources.tsunami) || 0,
          errors: Array.isArray(sources.errors) ? sources.errors.map(String).sort() : []
        }
      });
      await this.state.storage.put("lastPollAt", new Date(now).toISOString());
      await this.state.storage.put("lastSuccessfulPollAt", new Date(now).toISOString());

      const previous = await this.state.storage.get("signature");
      if (previous === undefined) {
        await this.state.storage.put("signature", signature);
        await this.state.storage.put("version", 1);
      } else if (previous !== signature) {
        const version = (Number(await this.state.storage.get("version")) || 0) + 1;
        await this.state.storage.put({ signature, version });
        this.broadcast("update", {
          version,
          detectedAt: new Date(now).toISOString(),
          reason: "catalogue_changed"
        }, version);
      }
    } finally {
      this.polling = false;
    }
  }
}
