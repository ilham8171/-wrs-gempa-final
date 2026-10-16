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
function isFeltBmkgReport(q) {
  if (!q || q.official !== true || !/BMKG/i.test(String(q.source || q.status || ""))) return false;
  const felt = String(q.felt || "").trim();
  return !!felt && !/^(?:—|-|tidak ada|none|n\/a|tidak dirasakan)$/i.test(felt) && !/tidak dirasakan/i.test(felt);
}
function eventTime(q) {
  let raw = String(q.time || q.timesent || "").trim();
  if (!raw) return 0;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (!hasTimezone && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)) {
    raw = raw.replace(" ", "T") + "+07:00";
  }
  const t = Date.parse(raw);
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
    title: (isFeltBmkgReport(q) ? "Gempa dirasakan M " : "Gempa M") + Number(q.magnitude || 0).toFixed(1) + " • WRS GEMPA",
    category: isFeltBmkgReport(q) ? "felt" : "big",
    felt: String(q.felt || ""),
    body: (q.place || "Lokasi tidak diketahui") + " · kedalaman " + (q.depth ?? "—") + " km",
    magnitude: Number(q.magnitude || 0),
    place: q.place || "",
    depth: q.depth ?? "",
    source: q.source || q.status || "BMKG/InaTEWS",
    lat: q.lat ?? "",
    lon: q.lon ?? "",
    time: q.time || new Date().toISOString(),
    tsunami: Boolean(q.usgsTsunamiFlag) || /berpotensi tsunami/i.test(q.potential || "") && !/tidak berpotensi tsunami/i.test(q.potential || ""),
    url: url.toString()
  };
}
function activeTsunamiPayload(item, now) {
  if (!item || item.ended || item.official !== true || item.isTsunamiWarning !== true) return null;
  // tsunamiHistory is an archive; only announce a public, live CAP bulletin.
  const status = String(item.capStatus || "").trim().toLowerCase();
  const msgType = String(item.capMsgType || "").trim().toLowerCase();
  const scope = String(item.capScope || "").trim().toLowerCase();
  const expiresAt = Date.parse(item.expires || "");
  if (status !== "actual" || !["alert", "update"].includes(msgType) ||
      (scope && scope !== "public") || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
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

let fcmCachedToken = null;
let fcmCachedExpiry = 0;
function bytesToB64Url(bytes) { let binary=""; for(const b of bytes) binary+=String.fromCharCode(b); return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
async function fcmAccessToken(sa) {
 if(fcmCachedToken && Date.now()<fcmCachedExpiry-60000) return fcmCachedToken;
 const now=Math.floor(Date.now()/1000), encJson=v=>bytesToB64Url(enc.encode(JSON.stringify(v)));
 const unsigned=encJson({alg:"RS256",typ:"JWT"})+"."+encJson({iss:sa.client_email,scope:"https://www.googleapis.com/auth/firebase.messaging",aud:sa.token_uri||"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});
 const privateKeyBeginMarker=["-----","BEGIN"," ","PRIVATE"," ","KEY","-----"].join("");
 const privateKeyEndMarker=["-----","END"," ","PRIVATE"," ","KEY","-----"].join("");
 const pem=String(sa.private_key||"").replace(new RegExp(privateKeyBeginMarker+"|"+privateKeyEndMarker,"g"),"").replace(/\s/g,"");
 if(!pem) throw new Error("FCM private key missing");
 const keyBytes=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey("pkcs8",keyBytes,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
 const sig=new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,enc.encode(unsigned)));
 const tokenResponse=await fetch(sa.token_uri||"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:unsigned+"."+bytesToB64Url(sig)})});
 const tokenJson=await tokenResponse.json();
 if(!tokenResponse.ok||!tokenJson.access_token) throw new Error("FCM OAuth HTTP "+tokenResponse.status);
 fcmCachedToken=tokenJson.access_token; fcmCachedExpiry=Date.now()+Number(tokenJson.expires_in||3600)*1000; return fcmCachedToken;
}
async function sendFcmTopic(sa,item) {
 if(!sa.project_id) throw new Error("FCM project_id missing");
 const token=await fcmAccessToken(sa);
 const tsunami=Boolean(item.tsunami);
 const felt=!tsunami && String(item.category||"").toLowerCase()==="felt";
 const category=tsunami?"tsunami":felt?"felt":"big";
 const data={title:String(item.title||"Peringatan WRS GEMPA"),body:String(item.body||"Ada pembaruan gempa."),category,type:category,key:String(item.key),quake_id:String(item.key),url:String(item.url||SITE),tsunami:tsunami?"true":"false",source:String(item.source||"BMKG/InaTEWS"),delivery_note:String(item.deliveryNote||""),quake_source:String(item.source||"BMKG/InaTEWS"),quake_magnitude:String(item.magnitude??""),magnitude:String(item.magnitude??""),quake_place:String(item.place||""),place:String(item.place||""),quake_time:String(item.time||""),time:String(item.time||""),quake_depth:String(item.depth??""),depth:String(item.depth??""),quake_felt:String(item.felt||""),felt:String(item.felt||""),lat:String(item.lat??""),lon:String(item.lon??"")};
 const res=await fetch("https://fcm.googleapis.com/v1/projects/"+encodeURIComponent(sa.project_id)+"/messages:send",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({message:{topic:"wrs-gempa-alerts",data,android:{priority:"HIGH",ttl:tsunami?"600s":"1800s"}}})});
 const responseText=await res.text(); if(!res.ok) throw new Error("FCM HTTP "+res.status+": "+responseText.slice(0,250)); return responseText;
}

const PUSH_BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const PUSH_WRS_LIVE_URL = "https://bmkg-content-inatews.storage.googleapis.com/lastQL.json";
const PUSH_USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
const PUSH_TSUNAMI_URL = "https://cdn.bmkg.go.id/last30tsunamievent.xml";

async function pushFetchResponse(url, label, cacheSeconds = 30, timeoutMs = 4500, xml = false) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: xml ? "application/xml,text/xml,*/*" : "application/json",
      ...(xml ? { referer: "https://inatews.bmkg.go.id/web/tsunami" } : {}),
      ...(cacheSeconds > 0 ? {} : { "cache-control": "no-cache, no-store", pragma: "no-cache" })
    },
    cf: cacheSeconds > 0
      ? { cacheTtl: cacheSeconds, cacheEverything: true }
      : { cacheTtl: 0, cacheEverything: false }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(label + " HTTP " + response.status + (detail ? ": " + detail.slice(0, 120) : ""));
  }
  return response;
}
async function pushFetchJson(url, label, cacheSeconds = 30) {
  const response = await pushFetchResponse(url, label, cacheSeconds);
  return response.json();
}
async function pushFetchXml(url, label, cacheSeconds = 15) {
  const response = await pushFetchResponse(url, label, cacheSeconds, 4500, true);
  return response.text();
}
function pushParseNumber(value) {
  if (value == null) return NaN;
  const match = String(value).trim().match(/[+-]?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : NaN;
}
function pushCoordinate(value, axis) {
  const raw = String(value ?? "").trim();
  const n = pushParseNumber(raw);
  if (!Number.isFinite(n)) return NaN;
  if (axis === "lat" && /LS|\bS\b/i.test(raw)) return -Math.abs(n);
  if (axis === "lat" && /LU|\bN\b/i.test(raw)) return Math.abs(n);
  if (axis === "lon" && /BB|\bW\b/i.test(raw)) return -Math.abs(n);
  if (axis === "lon" && /BT|\bE\b/i.test(raw)) return Math.abs(n);
  return n;
}
function pushValidCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
function normalizePushTime(raw, dateValue = "", timeValue = "") {
  if (typeof raw === "number" || (typeof raw === "string" && /^\d{10,13}$/.test(raw.trim()))) {
    const value = Number(raw);
    const ms = value < 100000000000 ? value * 1000 : value;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  }
  let value = String(raw ?? "").trim().replace(/\s*(WIB|UTC|GMT)\s*$/i, "").trim();
  if (!value && dateValue && timeValue) {
    const date = String(dateValue).trim();
    const time = String(timeValue).trim().replace(/\s*(WIB|UTC|GMT)\s*$/i, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(time)) {
      value = date + "T" + (time.length === 5 ? time + ":00" : time) + "+07:00";
    } else {
      value = date + " " + time;
    }
  }
  if (!value) return "";
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasTimezone && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    value = value.replace(" ", "T") + "+07:00";
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}
function mapPushBmkg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const coordinateText = String(raw.Coordinates || raw.coordinates || "");
  const parts = coordinateText.split(",");
  let lat = parts.length > 1 ? pushCoordinate(parts[0], "lat") : NaN;
  let lon = parts.length > 1 ? pushCoordinate(parts[1], "lon") : NaN;
  if (!Number.isFinite(lat)) lat = pushCoordinate(raw.Lintang ?? raw.latitude, "lat");
  if (!Number.isFinite(lon)) lon = pushCoordinate(raw.Bujur ?? raw.longitude, "lon");
  const magnitude = pushParseNumber(raw.Magnitude ?? raw.magnitude ?? raw.mag);
  const time = normalizePushTime(raw.DateTime ?? raw.datetime ?? raw.time, raw.Tanggal ?? raw.date, raw.Jam ?? raw.timeLocal);
  if (!Number.isFinite(magnitude) || !pushValidCoordinates(lat, lon) || !time) return null;
  const depth = pushParseNumber(raw.Kedalaman ?? raw.depth);
  return {
    key: "bmkg|" + time + "|" + lat.toFixed(2) + "|" + lon.toFixed(2) + "|M=" + magnitude.toFixed(1),
    magnitude,
    lat,
    lon,
    place: String(raw.Wilayah ?? raw.place ?? "Indonesia"),
    depth: Number.isFinite(depth) ? depth : "",
    time,
    potential: String(raw.Potensi ?? raw.potential ?? ""),
    felt: String(raw.Dirasakan ?? raw.felt ?? ""),
    source: "BMKG",
    status: "BMKG",
    official: true
  };
}
function pushFeatureList(value) {
  if (Array.isArray(value?.features)) return value.features;
  if (value?.type === "Feature") return [value];
  if (Array.isArray(value)) return value;
  return [];
}
function mapPushWrsFeature(feature) {
  const props = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates || [];
  const magnitude = pushParseNumber(props.mag ?? props.magnitude);
  const lon = pushParseNumber(coordinates[0]);
  const lat = pushParseNumber(coordinates[1]);
  const time = normalizePushTime(props.time ?? props.datetime ?? props.DateTime);
  if (!Number.isFinite(magnitude) || !pushValidCoordinates(lat, lon) || !time) return null;
  const id = String(props.id || [time, lat.toFixed(3), lon.toFixed(3)].join("|"));
  return {
    key: "ql|" + id + "|M=" + magnitude.toFixed(1),
    eventid: id,
    magnitude,
    lat,
    lon,
    place: String(props.place || "Indonesia"),
    depth: pushParseNumber(props.depth ?? coordinates[2]),
    time,
    potential: "",
    felt: "",
    source: "InaTEWS WRS",
    status: "InaTEWS WRS",
    wrsRealtime: true
  };
}
function mapPushUsgsFeature(feature) {
  const props = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates || [];
  const magnitude = pushParseNumber(props.mag);
  const lon = pushParseNumber(coordinates[0]);
  const lat = pushParseNumber(coordinates[1]);
  const time = normalizePushTime(props.time);
  if (!Number.isFinite(magnitude) || !pushValidCoordinates(lat, lon) || !time) return null;
  const indonesia = lat >= -11 && lat <= 6.5 && lon >= 94 && lon <= 141.5;
  if (indonesia ? magnitude < 3.0 : magnitude < 5.0) return null;
  const id = String(feature.id || props.code || time + "|" + lat + "|" + lon);
  return {
    key: "usgs|" + id + "|M=" + magnitude.toFixed(1),
    eventid: id,
    magnitude,
    lat,
    lon,
    place: String(props.place || "Gempa global"),
    depth: pushParseNumber(coordinates[2]),
    time,
    potential: "",
    felt: "",
    source: "USGS",
    status: "USGS",
    official: false,
    usgsTsunamiFlag: Number(props.tsunami) === 1
  };
}
function pushXmlDecode(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function pushXmlValue(block, tag) {
  const pattern = "<(?:[A-Za-z0-9_.-]+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?" + tag + "\\s*>";
  const match = String(block ?? "").match(new RegExp(pattern, "i"));
  return match ? pushXmlDecode(match[1].trim()) : "";
}
function parsePushTsunamiXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const alerts = xml.match(/<(?:[A-Za-z0-9_.-]+:)?alert\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?alert\s*>/gi) || [];
  const records = [];
  for (const parent of alerts.slice(0, 25)) {
    const infos = parent.match(/<(?:[A-Za-z0-9_.-]+:)?info\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?info\s*>/gi) || [];
    for (const info of (infos.length ? infos : [parent]).slice(0, 2)) {
      const read = (...tags) => {
        for (const tag of tags) {
          const value = pushXmlValue(info, tag) || (info !== parent ? pushXmlValue(parent, tag) : "");
          if (value) return value;
        }
        return "";
      };
      const subject = read("subject") || read("headline") || "WARNING TSUNAMI";
      const headline = read("headline");
      const description = read("description");
      const identifier = pushXmlValue(parent, "identifier") || pushXmlValue(parent, "eventid");
      const timesent = pushXmlValue(parent, "sent") || pushXmlValue(parent, "timesent");
      const status = (pushXmlValue(parent, "status") || read("status")).toLowerCase();
      const msgType = (pushXmlValue(parent, "msgType") || read("msgType") || pushXmlValue(parent, "messageType")).toLowerCase();
      const scope = (pushXmlValue(parent, "scope") || read("scope")).toLowerCase();
      const expires = read("expires");
      const joined = (subject + " " + headline + " " + description).toLowerCase();
      const ended = /telah\s*berakhir|berakhir|all[\s-]?clear|cancelled|canceled|dicabut|tidak ada peringatan/.test(joined) ||
        status === "cancel" || msgType === "cancel";
      records.push({
        key: "tsunami|" + (identifier || timesent || subject),
        eventid: identifier || timesent || subject,
        timesent,
        time: read("effective") || timesent,
        expires,
        subject,
        headline,
        description,
        potential: read("event") || subject + " " + headline,
        instruction: read("instruction"),
        ended,
        capStatus: status,
        capMsgType: msgType,
        capScope: scope,
        official: true,
        isTsunamiWarning: true
      });
    }
  }
  return records;
}
function pushDistanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const v = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));
}
function pushPriority(item) {
  if (item.source === "BMKG") return 3;
  if (String(item.source || "").includes("InaTEWS")) return 2;
  if (item.source === "USGS") return 1;
  return 0;
}
function pushSameEvent(a, b) {
  if (!pushValidCoordinates(a.lat, a.lon) || !pushValidCoordinates(b.lat, b.lon)) return false;
  const ta = eventTime(a), tb = eventTime(b);
  return Math.abs(ta - tb) <= 5 * 60 * 1000 &&
    pushDistanceKm(a, b) <= 35 &&
    Math.abs(Number(a.magnitude) - Number(b.magnitude)) <= 0.5;
}
async function fetchDirectPushRoot() {
  const jobs = await Promise.allSettled([
    ...PUSH_BMKG_URLS.map((url, index) => pushFetchJson(url, "BMKG feed " + (index + 1), 30)),
    pushFetchJson(PUSH_WRS_LIVE_URL, "InaTEWS realtime", 0),
    pushFetchJson(PUSH_USGS_URL, "USGS global M4.5+", 30),
    pushFetchXml(PUSH_TSUNAMI_URL, "InaTEWS tsunami history", 15)
  ]);
  const errors = [];
  const quakeEvents = [];
  let bmkgOk = 0;
  jobs.slice(0, 3).forEach((result, index) => {
    if (result.status !== "fulfilled") {
      errors.push("BMKG feed " + (index + 1) + ": " + String(result.reason?.message || result.reason).slice(0, 110));
      return;
    }
    bmkgOk++;
    const raw = result.value?.Infogempa?.gempa;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : []);
    for (const item of list.slice(0, 80)) {
      const mapped = mapPushBmkg(item);
      if (mapped) quakeEvents.push(mapped);
    }
  });
  const wrsJob = jobs[3];
  if (wrsJob.status === "fulfilled") {
    for (const item of pushFeatureList(wrsJob.value).slice(0, 100)) {
      const mapped = mapPushWrsFeature(item);
      if (mapped) quakeEvents.push(mapped);
    }
  } else {
    errors.push("InaTEWS realtime: " + String(wrsJob.reason?.message || wrsJob.reason).slice(0, 110));
  }
  const usgsJob = jobs[4];
  if (usgsJob.status === "fulfilled") {
    for (const item of pushFeatureList(usgsJob.value).slice(0, 180)) {
      const mapped = mapPushUsgsFeature(item);
      if (mapped) quakeEvents.push(mapped);
    }
  } else {
    errors.push("USGS global: " + String(usgsJob.reason?.message || usgsJob.reason).slice(0, 110));
  }
  const tsunamiJob = jobs[5];
  const tsunamiHistory = tsunamiJob.status === "fulfilled"
    ? parsePushTsunamiXml(tsunamiJob.value)
    : [];
  if (tsunamiJob.status !== "fulfilled") {
    errors.push("InaTEWS tsunami: " + String(tsunamiJob.reason?.message || tsunamiJob.reason).slice(0, 110));
  }
  const successfulFeeds = jobs.filter(result => result.status === "fulfilled").length;
  if (successfulFeeds === 0) {
    throw new Error("All direct earthquake/tsunami feeds failed: " + errors.slice(0, 4).join(" | "));
  }
  const now = Date.now();
  const eligibleWindow = quakeEvents.filter(item => {
    const eventMs = eventTime(item);
    const age = now - eventMs;
    return eventMs > 0 && age >= -60000 && age <= 30 * 60 * 1000;
  }).sort((a, b) =>
    pushPriority(b) - pushPriority(a) || eventTime(b) - eventTime(a)
  );
  const unique = [];
  for (const item of eligibleWindow) {
    if (unique.some(previous => pushSameEvent(previous, item))) continue;
    unique.push(item);
    if (unique.length >= 100) break;
  }
  unique.sort((a, b) => eventTime(b) - eventTime(a));
  return {
    ok: true,
    fetchedAt: new Date(now).toISOString(),
    recent: unique,
    tsunamiHistory,
    sources: {
      bmkg: bmkgOk,
      wrs: wrsJob.status === "fulfilled",
      usgsGlobal: usgsJob.status === "fulfilled",
      tsunami: tsunamiJob.status === "fulfilled" ? tsunamiHistory.length : 0,
      errors
    }
  };
}
async function runPush(env) {
  if (!env.PUSH_SUBSCRIPTIONS) {
    console.error("PUSH_SUBSCRIPTIONS KV binding is missing.");
    return;
  }
  // Web Push readiness must not block Android FCM.
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
      console.warn("VAPID keys unavailable; Web Push delivery will be skipped.");
    }
  } catch (error) {
    console.error("Web Push configuration unavailable:", error.message || error);
  }
  const subject = SITE;
  const root = await fetchDirectPushRoot();
  const feedUsed = "direct-upstream-feeds";
  const now = Date.now();
  const warnings = (Array.isArray(root.tsunamiHistory) ? root.tsunamiHistory : [])
    .map(item => activeTsunamiPayload(item, now)).filter(Boolean).slice(0, 1);
  const quakes = (Array.isArray(root.recent) ? root.recent : [])
    .filter(q => {
      const age = now - eventTime(q);
      if (age < -60000 || age > 30 * 60 * 1000) return false;
      const mag = Number(q.magnitude || 0);
      const feltReport = isFeltBmkgReport(q);
      // Official BMKG felt reports are push-worthy even when below the normal M3 Indonesia threshold.
      return isIndonesia(q) ? (mag >= 3.0 || feltReport) : mag >= 5.0;
    })
    .sort((a,b) => eventTime(b)-eventTime(a))
    .slice(0, MAX_EVENTS_PER_RUN)
    .map(q => {
      const payload = makeQuakePayload(q);
      const ageMs = now - eventTime(q);
      if (ageMs > 5 * 60 * 1000) {
        payload.deliveryNote = "Pembaruan terlambat · kejadian sekitar " + Math.round(ageMs / 60000) + " menit lalu";
        payload.body += "\n" + payload.deliveryNote;
      }
      return payload;
    });
  const events = [...warnings, ...quakes].filter((q, i, a) => a.findIndex(x => x.key === q.key) === i);
  console.log("Push scan", JSON.stringify({
    feed: feedUsed,
    fetchedAt: root.fetchedAt || null,
    catalogCount: Array.isArray(root.recent) ? root.recent.length : 0,
    eligibleQuakes: quakes.length,
    activeTsunamiWarnings: warnings.length,
    pendingUnique: events.length,
    feedErrors: Array.isArray(root.sources && root.sources.errors) ? root.sources.errors.slice(0, 4) : []
  }));
  if (!events.length) return;

  // Native Android topic push is sent separately from browser Web Push.
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
      const sentKey = SENT_PREFIX + "fcm-topic";
      const previous = await env.PUSH_SUBSCRIPTIONS.get(sentKey, "json") || [];
      const sent = new Set(Array.isArray(previous) ? previous : []);
      for (const item of events) {
        if (sent.has(item.key)) continue;
        try { await sendFcmTopic(sa, item); sent.add(item.key); console.log("FCM accepted", item.key); }
        catch (error) { console.error("FCM delivery failed", error.message || error); }
      }
      await env.PUSH_SUBSCRIPTIONS.put(sentKey, JSON.stringify(Array.from(sent).slice(-500)));
    } catch (error) { console.error("FCM config error", error.message || error); }
  } else {
    console.warn("FCM_SERVICE_ACCOUNT_JSON secret missing; Android push disabled, browser push still runs.");
  }

  // Browser delivery is isolated: missing VAPID skips Web Push only, after FCM.
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
    ctx.waitUntil(runPush(env).catch(error => console.error("Scheduled push run failed: " + String(error && error.message || error), error && error.stack || "")));
  }
};