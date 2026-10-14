const SITE = "https://wrs-gempa-final.pages.dev";
const SUB_PREFIX = "sub:";
const SENT_PREFIX = "sent:";
const MAX_EVENTS_PER_RUN = 5;

const enc = new TextEncoder();
const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const unb64u = (s) => {
  const base = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - base.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
};
const concat = (...parts) => {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
async function hkdfExpand(prk, info, length) {
  let output = new Uint8Array(0), previous = new Uint8Array(0), counter = 1;
  while (output.length < length) {
    previous = await hmac(prk, concat(previous, info, new Uint8Array([counter++])));
    output = concat(output, previous);
  }
  return output.slice(0, length);
}
async function vapidToken(endpoint, privateJwk, subject) {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(enc.encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: subject || SITE
  })));
  const unsigned = header + "." + payload;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)
  ));
  return unsigned + "." + b64u(signature);
}
async function encryptPayload(subscription, payload) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));

  const authPrk = await hmac(authSecret, shared);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plain = concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
async function sendPush(subscription, payload, privateJwk, publicKey, subject) {
  const token = await vapidToken(subscription.endpoint, privateJwk, subject);
  const body = await encryptPayload(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": "vapid t=" + token + ", k=" + publicKey,
      "Crypto-Key": "p256ecdsa=" + publicKey,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "300",
      "Urgency": payload.tsunami ? "high" : "normal"
    },
    body
  });
  if (!response.ok) {
    const error = new Error("Push provider HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
}
function isIndonesia(q) {
  return Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon)) &&
    Number(q.lat) >= -11 && Number(q.lat) <= 6.5 &&
    Number(q.lon) >= 94 && Number(q.lon) <= 141.5;
}
function eventTime(q) {
  const t = new Date(q.time || q.timesent || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}
function makeQuakePayload(q) {
  const key = String(q.key || q.eventid || q.time + "|" + q.magnitude + "|" + q.place);
  const url = new URL("/", SITE);
  url.searchParams.set("quake", key);
  if (q.lat != null) url.searchParams.set("lat", q.lat);
  if (q.lon != null) url.searchParams.set("lon", q.lon);
  if (q.magnitude != null) url.searchParams.set("mag", q.magnitude);
  if (q.time) url.searchParams.set("time", q.time);
  return {
    key,
    title: "Gempa M" + Number(q.magnitude || 0).toFixed(1) + " • WRS GEMPA",
    body: (q.place || "Lokasi tidak diketahui") + " · kedalaman " + (q.depth ?? "—") + " km",
    magnitude: Number(q.magnitude || 0),
    place: q.place || "",
    time: q.time || new Date().toISOString(),
    tsunami: Boolean(q.usgsTsunamiFlag) || /berpotensi tsunami/i.test(q.potential || "") && !/tidak berpotensi tsunami/i.test(q.potential || ""),
    url: url.toString()
  };
}
function activeTsunamiPayload(item, now) {
  if (!item || item.ended) return null;
  const age = now - eventTime(item);
  if (age < -60000 || age > 24 * 60 * 60 * 1000) return null;
  const text = [item.subject, item.headline, item.potential].join(" ").toLowerCase();
  const negative = text.includes("tidak berpotensi tsunami") || text.includes("tidak ada peringatan") || text.includes("no tsunami");
  if (negative || !(text.includes("warning tsunami") || text.includes("peringatan dini tsunami") || text.includes("berpotensi tsunami"))) return null;
  const key = "tsunami|" + String(item.key || item.eventid || item.timesent || item.time);
  const url = new URL("/", SITE);
  url.searchParams.set("tab", "tsunami");
  return {
    key,
    title: "PERINGATAN TSUNAMI • WRS GEMPA",
    body: String(item.headline || item.subject || item.potential || "Periksa instruksi resmi BMKG/InaTEWS"),
    magnitude: Number(item.magnitude || 0),
    time: item.time || item.timesent || new Date().toISOString(),
    tsunami: true,
    url: url.toString()
  };
}
async function listSubscriptions(kv) {
  const all = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: SUB_PREFIX, limit: 1000, cursor });
    all.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return all;
}
async function runPush(env) {
  if (!env.PUSH_SUBSCRIPTIONS) {
    console.error("PUSH_SUBSCRIPTIONS KV binding is missing.");
    return;
  }
  // VAPID configuration controls browser delivery only. It must not abort event processing.
  let privateJwk = null;
  let publicKey = null;
  try {
    const [privateText, publicText] = await Promise.all([
      env.PUSH_SUBSCRIPTIONS.get("vapid:private"),
      env.PUSH_SUBSCRIPTIONS.get("vapid:public")
    ]);
    if (privateText && publicText) {
      privateJwk = JSON.parse(privateText);
      publicKey = publicText;
    } else {
      console.warn("VAPID key pair is not initialized; Web Push delivery will be skipped.");
    }
  } catch (error) {
    console.error("Web Push configuration unavailable:", error.message || error);
  }
  const subject = SITE;
  const res = await fetch(SITE + "/api/earthquakes?push=" + Date.now(), {
    headers: { "Accept": "application/json", "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error("Earthquake API HTTP " + res.status);
  const root = await res.json();
  const now = Date.now();
  const warnings = (Array.isArray(root.tsunamiHistory) ? root.tsunamiHistory : [])
    .map(item => activeTsunamiPayload(item, now)).filter(Boolean).slice(0, 1);
  // Scheduled every minute: reject old catalog records so a delayed worker run
  // cannot announce a historic earthquake as if it had just happened.
  const MAX_QUAKE_ALERT_AGE_MS = 5 * 60 * 1000;
  const quakes = (Array.isArray(root.recent) ? root.recent : [])
    .filter(q => {
      const age = now - eventTime(q);
      if (age < -60000 || age > MAX_QUAKE_ALERT_AGE_MS) return false;
      const mag = Number(q.magnitude || 0);
      return isIndonesia(q) ? mag >= 3.0 : mag >= 5.0;
    })
    .sort((a,b) => eventTime(b)-eventTime(a))
    .slice(0, MAX_EVENTS_PER_RUN)
    .map(makeQuakePayload);
  const events = [...warnings, ...quakes].filter((q, i, a) => a.findIndex(x => x.key === q.key) === i);
  if (!events.length) return;

  // Skip only browser delivery when VAPID keys are unavailable; event selection still runs.
  if (!privateJwk || !publicKey) return;
  const subscriptions = await listSubscriptions(env.PUSH_SUBSCRIPTIONS);
  for (const entry of subscriptions) {
    const storageKey = entry.name;
    const sub = await env.PUSH_SUBSCRIPTIONS.get(storageKey, "json");
    if (!sub || !sub.endpoint) continue;
    const hash = storageKey.slice(SUB_PREFIX.length);
    const sentKey = SENT_PREFIX + hash;
    const sent = await env.PUSH_SUBSCRIPTIONS.get(sentKey, "json") || [];
    const sentSet = new Set(Array.isArray(sent) ? sent : []);
    for (const item of events) {
      if (sentSet.has(item.key)) continue;
      try {
        await sendPush(sub, item, privateJwk, publicKey, subject);
        sentSet.add(item.key);
      } catch (error) {
        if (error.status === 404 || error.status === 410) {
          await env.PUSH_SUBSCRIPTIONS.delete(storageKey);
          await env.PUSH_SUBSCRIPTIONS.delete(sentKey);
          break;
        }
        console.error("Push delivery failed:", error.status || error.message);
      }
    }
    await env.PUSH_SUBSCRIPTIONS.put(sentKey, JSON.stringify(Array.from(sentSet).slice(-100)));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("WRS GEMPA push worker OK", { status: 200 });
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runPush(env).catch(error => console.error("Scheduled push run failed:", error)));
  }
};
