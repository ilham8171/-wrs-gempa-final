const BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const GCS = "https://bmkg-content-inatews.storage.googleapis.com";
// Use USGS's prefiltered M5+ feed: it is much smaller than all_week.geojson and avoids parsing thousands of irrelevant low-magnitude records on cold edge refreshes.
// USGS publishes a documented 4.5+ summary feed; filter it to M5+ below. A second known feed is used only if this one is malformed or temporarily unavailable.
const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson";
const USGS_ALL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
function usgsIndonesiaUrl() {
  // This regional request is a supplemental fallback, so keep its payload
  // bounded to the latest 72 hours; BMKG/InaTEWS remains the primary catalogue.
  // Round to the minute so the query URL remains cacheable across polling cycles.
  // The extra 0-59 seconds in the lookback is harmless and avoids a unique URL
  // on every request, which would defeat Cloudflare's upstream response cache.
  const roundedNow = Math.floor(Date.now() / 60000) * 60000;
  const starttime = new Date(roundedNow - 3 * 864e5).toISOString().slice(0, 19);
  return "https://earthquake.usgs.gov/fdsnws/event/1/query?" + new URLSearchParams({
    format: "geojson",
    starttime,
    minlatitude: "-11",
    maxlatitude: "6.5",
    minlongitude: "94",
    maxlongitude: "141.5",
    minmagnitude: "2",
    orderby: "time",
    limit: "100"
  }).toString();
}
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };

// A separate KV namespace preserves a last-known-good full catalogue across
// Cloudflare edge locations. This is intentionally separate from push subscriptions.
const DURABLE_LAST_GOOD_KEY = "catalogue:last-good:v1";
const DURABLE_LAST_GOOD_MAX_AGE_MS = 20 * 60 * 1000;
const DURABLE_LAST_GOOD_TTL_SECONDS = 30 * 60;
let lastDurableCacheWriteAt = 0;

// Cache persistence must never turn an otherwise valid API response into a
// request failure. Some runtimes can reject waitUntil when its execution
// context is no longer valid; in that case, try the cache task directly.
async function scheduleCacheTask(task, waitUntil, label) {
  if (typeof waitUntil === "function") {
    try {
      waitUntil(task);
      return;
    } catch (error) {
      console.warn("[WRS API] waitUntil unavailable for " + label + "; using direct task:",
        String(error?.message || error).slice(0, 120));
    }
  }
  try {
    await task;
  } catch (error) {
    console.warn("[WRS API] Cache task failed (" + label + "):",
      String(error?.message || error).slice(0, 120));
  }
}

async function readDurableLastGood(env) {
  const kv = env?.WRS_API_CACHE;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const record = await kv.get(DURABLE_LAST_GOOD_KEY, "json");
    const payload = record?.payload;
    if (record?.version !== 1 || payload?.ok !== true ||
        !Array.isArray(payload.recent) || payload.recent.length === 0) return null;
    const savedAt = Number(record.savedAt);
    const fallbackAt = Date.parse(payload.fetchedAt || "");
    const referenceTime = Number.isFinite(savedAt) && savedAt > 0 ? savedAt : fallbackAt;
    const ageMs = Date.now() - referenceTime;
    if (!Number.isFinite(referenceTime) || ageMs < 0 ||
        ageMs > DURABLE_LAST_GOOD_MAX_AGE_MS) return null;
    return { payload, ageSeconds: Math.floor(ageMs / 1000) };
  } catch (error) {
    console.warn("[WRS API] Durable last-good cache read failed:",
      String(error?.message || error).slice(0, 120));
    return null;
  }
}

async function writeDurableLastGood(env, payload) {
  const kv = env?.WRS_API_CACHE;
  if (!kv || typeof kv.put !== "function" || payload?.ok !== true ||
      payload?.sources?.emergencyFallback === true ||
      !Array.isArray(payload.recent) || payload.recent.length === 0) return;
  const now = Date.now();
  // The edge cache already serves repeated polls. Limit durable writes to reduce
  // KV traffic; a failed write never turns a successful API response into an error.
  if (now - lastDurableCacheWriteAt < 30_000) return;
  lastDurableCacheWriteAt = now;
  try {
    await kv.put(DURABLE_LAST_GOOD_KEY, JSON.stringify({
      version: 1,
      savedAt: now,
      payload
    }), { expirationTtl: DURABLE_LAST_GOOD_TTL_SECONDS });
  } catch (error) {
    lastDurableCacheWriteAt = 0;
    console.warn("[WRS API] Durable last-good cache write failed:",
      String(error?.message || error).slice(0, 120));
  }
}
const num = v => { const n = Number(String(v ?? "").replace(/,/g, ".").trim()); return Number.isFinite(n) ? n : NaN; };
function parseLat(v) {
  if (v == null) return NaN;
  const s = String(v).trim(), n = parseFloat(s.replace(/,/g, "."));
  if (!Number.isFinite(n)) return NaN;
  if (/LS|S\b/i.test(s)) return -Math.abs(n);
  if (/LU|N\b/i.test(s)) return Math.abs(n);
  return n;
}
function parseLon(v) {
  if (v == null) return NaN;
  const s = String(v).trim(), n = parseFloat(s.replace(/,/g, "."));
  if (!Number.isFinite(n)) return NaN;
  if (/BB|W\b/i.test(s)) return -Math.abs(n);
  if (/BT|E\b/i.test(s)) return Math.abs(n);
  return n;
}
function mapPublic(raw) {
  if (!raw) return null;
  const coordinateText = String(raw.Coordinates ?? raw.coordinates ?? "").trim();
  const coords = coordinateText.split(",");
  let lat = coords.length > 1 ? parseLat(coords[0]) : NaN;
  let lon = coords.length > 1 ? parseLon(coords[1]) : NaN;
  // WRS/InaTEWS sometimes formats coordinates with compass suffixes and no comma.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const latToken = coordinateText.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:LS|LU|S|N)\b/i)?.[0];
    const lonToken = coordinateText.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:BT|BB|E|W)\b/i)?.[0];
    if (!Number.isFinite(lat) && latToken) lat = parseLat(latToken);
    if (!Number.isFinite(lon) && lonToken) lon = parseLon(lonToken);
  }
  if (!Number.isFinite(lat)) lat = parseLat(raw.Lintang);
  if (!Number.isFinite(lon)) lon = parseLon(raw.Bujur);
  const mag = num(raw.Magnitude ?? raw.magnitude);
  if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const time = String(raw.DateTime || "");
  let shakemap = raw.Shakemap ?? raw.shakemap ?? null;
  if (shakemap) {
    shakemap = String(shakemap).trim();
    if (/^https?:\/\//i.test(shakemap)) shakemap = shakemap.replace(/^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i, GCS + "/");
    else shakemap = GCS + "/" + shakemap.replace(/^\/+/, "");
  } else if (time) {
    const digits = time.replace(/\D/g, "");
    if (digits.length >= 14) shakemap = GCS + "/" + digits.slice(0,14) + ".mmi.jpg";
  }
  return { key:"bmkg|"+(time || raw.Tanggal+"|"+raw.Jam+"|"+mag), magnitude:mag, lat:Number.isFinite(lat)?lat:null, lon:Number.isFinite(lon)?lon:null, place:String(raw.Wilayah || "Indonesia"), depth:String(raw.Kedalaman || "—").match(/[0-9]+(?:[.,][0-9]+)?/)?.[0] || "—", time, potential:String(raw.Potensi || "—"), felt:String(raw.Dirasakan || ""), source:"BMKG", status:"BMKG", official:true, shakemap };
}
function isoTimeOrEmpty(value) {
  if (value == null || value === "") return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
function mapQL(f) {
  const p=f?.properties||{}, c=f?.geometry?.coordinates||[], mag=num(p.mag ?? p.magnitude), lon=num(c[0]), lat=num(c[1]);
  if (!Number.isFinite(mag)||!Number.isFinite(lat)||!Number.isFinite(lon)||mag<1.5) return null;
  // Pertahankan nama lokasi asli dari feed InaTEWS; jangan menggantinya
  // dengan tebakan wilayah berdasarkan koordinat.
  const place = String(p.place || "Indonesia");
  // The WRS display's explicit properties.depth is the preferred value when
  // present; GeoJSON coordinates[2] is only a fallback. Some feed revisions
  // have disagreed between these two fields, which made our display show 1 km.
  const depthCandidates = [p.depth, c[2]];
  const depth = depthCandidates.map(value => {
    if (value == null || String(value).trim() === "") return null;
    const n = num(value);
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  }).find(value => value !== null) ?? "—";
  // A malformed timestamp in one upstream record must not throw RangeError
  // and turn the entire catalogue request into HTTP 503.
  const time = isoTimeOrEmpty(p.time);
  return {key:"ql|"+String(p.id||p.time+"|"+lat+"|"+lon),eventid:String(p.id||p.time+"|"+lat+"|"+lon),magnitude:mag,lat,lon,place,depth,time,potential:"—",felt:"",source:"InaTEWS",status:"M",wrsRealtime:true};
}
function mapUSGS(f, minimumMagnitude = 5) {
  const p=f?.properties||{}, c=f?.geometry?.coordinates||[], mag=num(p.mag), lon=num(c[0]), lat=num(c[1]), flag=Number(p.tsunami)===1;
  // The supplemental global catalogue is strictly M5.0+.
  // USGS's tsunami flag is metadata only and must not bypass the magnitude filter.
  if (!Number.isFinite(mag) || mag < minimumMagnitude) return null;
  if (!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  return {key:"usgs|"+String(f.id||p.code||p.time),eventid:String(f.id||""),magnitude:Number.isFinite(mag)?Math.round(mag*10)/10:0,lat,lon,place:String(p.place||"Gempa global"),depth:String(c[2]??"—"),time:isoTimeOrEmpty(p.time),potential:flag?"USGS menandai event terkait tsunami — periksa buletin resmi":"—",felt:"",source:"USGS",status:"USGS",official:false,usgsTsunamiFlag:flag,eventUrl:String(p.url||""),detailUrl:String(p.detail||""),shakemap:null};
}

// Cache expensive, already-normalized optional catalogues at the edge. The main
// API still refreshes InaTEWS lastQL live; these caches prevent repeatedly parsing
// the much larger history/global feeds on every 10-second catalogue refresh.
function normalizedFeedCacheKey(request, name) {
  if (!request?.url) return null;
  try {
    const url = new URL(request.url);
    url.pathname = "/__wrs_internal_cache__/" + name;
    url.search = "";
    url.hash = "";
    return new Request(url.toString(), { method: "GET" });
  } catch (_) {
    return null;
  }
}
async function readNormalizedFeedCache(cache, key) {
  if (!cache || !key) return null;
  try {
    const response = await cache.match(key);
    if (!response) return null;
    const payload = await response.json();
    const fetchedAtMs = Date.parse(payload?.fetchedAt || "");
    if (!Array.isArray(payload?.events) || !Number.isFinite(fetchedAtMs)) return null;
    return { events: payload.events, fetchedAtMs, ageMs: Date.now() - fetchedAtMs };
  } catch (_) {
    return null;
  }
}
async function writeNormalizedFeedCache(cache, key, events) {
  if (!cache || !key || !Array.isArray(events)) return;
  try {
    const payload = { fetchedAt: new Date().toISOString(), events };
    await cache.put(key, new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Keep a stale copy available; freshness is checked against fetchedAt below.
        "cache-control": "public, max-age=86400"
      }
    }));
  } catch (_) {
    // Optional cache storage must never make the live API fail.
  }
}
async function loadNormalizedFeed({ cache, request, name, ttlMs, load, map }) {
  const key = normalizedFeedCacheKey(request, name);
  const cached = await readNormalizedFeedCache(cache, key);
  const cachedAgeMs = cached ? Date.now() - cached.fetchedAtMs : Infinity;
  if (cached && cachedAgeMs >= 0 && cachedAgeMs <= ttlMs) {
    return {
      status: "fulfilled", value: cached.events, cacheHit: true, stale: false,
      cacheAgeSeconds: Math.floor(cachedAgeMs / 1000)
    };
  }
  try {
    const raw = await load();
    const events = map(raw);
    if (!Array.isArray(events)) throw new Error(name + " menghasilkan data yang tidak valid");
    await writeNormalizedFeedCache(cache, key, events);
    return { status: "fulfilled", value: events, cacheHit: false, stale: false, cacheAgeSeconds: 0 };
  } catch (error) {
    // Optional catalogue failures are isolated: reuse the last normalized copy
    // when available, rather than escalating a USGS/history issue to API HTTP 503.
    if (cached && cachedAgeMs >= 0 && Array.isArray(cached.events)) {
      return {
        status: "fulfilled", value: cached.events, cacheHit: true, stale: true,
        cacheAgeSeconds: Math.floor(cachedAgeMs / 1000),
        sourceError: String(error?.message || error).slice(0, 180)
      };
    }
    return { status: "rejected", reason: error };
  }
}
async function loadCachedHistoryEvents(options) {
  return loadNormalizedFeed({
    ...options,
    name: "inatews-gempa-history-v1",
    ttlMs: 5 * 60 * 1000,
    load: () => getJson(GCS + "/gempaQL.json", false, 4500, 300),
    map: value => {
      if (!(Array.isArray(value?.features) || value?.type === "Feature" || Array.isArray(value))) {
        throw new Error("respons InaTEWS gempaQL tidak memiliki daftar fitur");
      }
      return qlFeatures(value).slice(0, 350).map(mapQL).filter(Boolean)
        .sort((a, b) => (Date.parse(b.time || "") || 0) - (Date.parse(a.time || "") || 0))
        .slice(0, 250)
        .map(q => ({ ...q, source: "InaTEWS", wrsRealtime: false }));
    }
  });
}
async function loadCachedUSGSEvents(options) {
  return loadNormalizedFeed({
    ...options,
    name: "usgs-global-m5-v1",
    ttlMs: 60 * 1000,
    load: async () => {
      let primaryError;
      try {
        const value = await getJson(USGS, false, 5000, 60);
        if (!Array.isArray(value?.features)) throw new Error("respons USGS 4.5+ tidak memiliki daftar fitur");
        return value;
      } catch (error) {
        primaryError = error;
      }
      // Recovery path: the broad, long-standing USGS all-earthquakes feed is used
      // only when the smaller 4.5+ feed fails. Filter M5+ before mapping to keep
      // the rest of the application and notification thresholds unchanged.
      try {
        const value = await getJson(USGS_ALL, false, 6500, 60);
        if (!Array.isArray(value?.features)) throw new Error("respons USGS all-week tidak memiliki daftar fitur");
        return {
          ...value,
          features: value.features.filter(feature => Number(feature?.properties?.mag) >= 5)
        };
      } catch (fallbackError) {
        throw new Error("USGS 4.5+ gagal (" + String(primaryError?.message || primaryError).slice(0, 90) +
          "); feed cadangan all-week gagal (" + String(fallbackError?.message || fallbackError).slice(0, 90) + ")");
      }
    },
    map: value => value.features.filter(feature => Number(feature?.properties?.mag) >= 5)
      .slice(0, 500).map(feature => mapUSGS(feature, 5)).filter(Boolean)
  });
}

async function loadCachedUSGSIndonesiaEvents(options) {
  return loadNormalizedFeed({
    ...options,
    name: "usgs-indonesia-m2-72h-v1",
    ttlMs: 60 * 1000,
    load: async () => {
      const value = await getJson(usgsIndonesiaUrl(), false, 4500, 60);
      if (!Array.isArray(value?.features)) throw new Error("respons USGS Indonesia tidak memiliki daftar fitur");
      return value;
    },
    map: value => value.features.slice(0, 120).map(feature => mapUSGS(feature, 2)).filter(Boolean)
  });
}

function plainAtomText(value) {
  return decodeXmlText(String(value ?? ""))
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAtomTsunamiFeed(xml, center) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const entries = xml.match(/<(?:[\w.-]+:)?entry\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?entry\s*>/gi) || [];
  const messages = [];
  for (const entry of entries.slice(0, 20)) {
    const title = plainAtomText(textBetween(entry, "title"));
    const summary = plainAtomText(textBetween(entry, "summary") || textBetween(entry, "content"));
    const updatedRaw = plainAtomText(textBetween(entry, "updated") || textBetween(entry, "published"));
    if (!title && !summary) continue;
    const parsedTime = Date.parse(updatedRaw);
    const updated = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : updatedRaw.slice(0, 80);
    const linkTags = entry.match(/<(?:[\w.-]+:)?link\b[^>]*>/gi) || [];
    const linkTag = linkTags.find(tag => !/\brel\s*=\s*["']self["']/i.test(tag)) || linkTags[0] || "";
    const linkMatch = linkTag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const url = linkMatch ? plainAtomText(linkMatch[1]).replace(/&amp;/g, "&") : "https://www.tsunami.gov/";
    const scope = center === "PTWC"
      ? "Pasifik, Karibia, dan wilayah layanan internasional PTWC"
      : "Alaska, pesisir Amerika Serikat, dan Kanada";
    messages.push({
      key: center + "|" + (url || updated || title),
      source: center,
      title: title.slice(0, 220) || "Pesan tsunami resmi",
      summary: summary.slice(0, 650),
      updated,
      url,
      scope
    });
  }
  const unique = new Map();
  messages.forEach(message => { if (!unique.has(message.key)) unique.set(message.key, message); });
  return [...unique.values()].sort((a, b) =>
    (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0)).slice(0, 12);
}

async function loadCachedGlobalTsunamiFeed(options, center, url) {
  return loadNormalizedFeed({
    ...options,
    name: "official-tsunami-" + center.toLowerCase() + "-atom-v1",
    ttlMs: 30 * 1000,
    load: async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(4500),
        headers: { accept: "application/atom+xml, application/xml, text/xml, */*" },
        cf: { cacheTtl: 30, cacheEverything: true }
      });
      if (!response.ok) throw new Error(center + " feed HTTP " + response.status);
      const xml = await response.text();
      if (!/<(?:[\w.-]+:)?feed\b/i.test(xml)) throw new Error(center + " feed bukan dokumen Atom");
      if (!/<(?:[\w.-]+:)?entry\b/i.test(xml)) throw new Error(center + " feed tidak memuat pesan yang dapat dibaca");
      return xml;
    },
    map: xml => {
      const messages = parseAtomTsunamiFeed(xml, center);
      if (!messages.length) throw new Error(center + " feed tidak memuat pesan yang dapat dibaca");
      return messages;
    }
  });
}

async function attachUSGSShakemaps(events) {
  const indonesia = q => q.lat >= -11 && q.lat <= 6.5 && q.lon >= 94 && q.lon <= 141.5;
  const candidates = events
    .filter(q => q.source === "USGS" && q.detailUrl && q.magnitude >= 4)
    .sort((a,b) => Number(indonesia(b))-Number(indonesia(a)) || b.magnitude-a.magnitude || new Date(b.time||0)-new Date(a.time||0))
    .slice(0, 4);
  await Promise.all(candidates.map(async q => {
    try {
      const detail = await getJson(q.detailUrl, false, 1800);
      const products = detail?.properties?.products?.shakemap || [];
      const product = products.find(p => p?.contents) || products[0];
      const contents = product?.contents || {};
      const image = contents["download/intensity.jpg"]?.url ||
        contents["download/intensity.png"]?.url ||
        contents["download/intensity.jpeg"]?.url;
      if (image) {
        q.shakemap = image;
        q.shakemapSource = "USGS ShakeMap";
      }
    } catch (_) { /* ShakeMap is optional; keep the earthquake event. */ }
  }));
}
function textBetween(xml, tag) {
  // CAP XML may namespace tags (for example cap:headline); support both forms.
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("<(?:[\\w.-]+:)?" + escaped + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + escaped + "\\s*>", "i");
  const match = String(xml ?? "").match(re);
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}
function capEventTime(date, time) {
  const d = String(date ?? "").trim();
  const t = String(time ?? "").trim().replace(/\s*(WIB|UTC|GMT)\s*/ig, "");
  if (!d && !t) return "";
  const isoBase = (d ? d : "").replace(/\s+/g, "");
  let candidate = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoBase) && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
    const normalizedTime = t.length === 5 ? t + ":00" : t;
    candidate = isoBase + "T" + normalizedTime + "+07:00";
  } else {
    candidate = d + " " + t;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? candidate : parsed.toISOString();
}
function mapCapAsset(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i, GCS + "/");
  }
  return GCS + "/" + value.replace(/^\/+/, "");
}
function capValue(block, ...names) {
  for (const name of names) {
    const direct = textBetween(block, name);
    if (direct) return direct;
  }
  const wanted = new Set(names.map(n => n.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  const params = String(block).match(/<(?:[\w.-]+:)?parameter\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?parameter\s*>/gi) || [];
  for (const param of params) {
    const key = textBetween(param, "valueName").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (wanted.has(key)) {
      const value = textBetween(param, "value");
      if (value) return value;
    }
  }
  return "";
}

function parseTsunamiCapXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  // InaTEWS' XML feed has changed wrapper formats over time. Parse CAP alert
  // records when present, but also accept Atom/RSS entry/item wrappers and a
  // bare info record. Read each field from info first, then parent metadata.
  const alerts = xml.match(/<(?:[\w.-]+:)?alert\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?alert\s*>/gi) || [];
  const entries = alerts.length ? alerts :
    (xml.match(/<(?:[\w.-]+:)?(?:entry|item)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:entry|item)\s*>/gi) || []);
  const parents = entries.length ? entries : [xml];
  const list = [];
  const value = (info, parent, ...names) => capValue(info, ...names) || (parent !== info ? capValue(parent, ...names) : "");
  for (const parent of parents) {
    const infos = parent.match(/<(?:[\w.-]+:)?info\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?info\s*>/gi) || [];
    const records = infos.length ? infos : [parent];
    for (const block of records) {
      const subject = value(block, parent, "subject", "headline") || "WARNING TSUNAMI";
      const headline = value(block, parent, "headline");
      const description = value(block, parent, "description", "summary");
      let date = value(block, parent, "date", "tanggal");
      let time = value(block, parent, "time", "jam");
      const originTime = value(block, parent, "EventOriginTime", "originTime", "datetime", "effective");
      if ((!date || !time) && originTime) {
        const parsedOrigin = new Date(originTime);
        if (!Number.isNaN(parsedOrigin.getTime())) {
          date = date || new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).format(parsedOrigin);
          time = time || new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Jakarta",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(parsedOrigin) + " WIB";
        }
      }
      const coordText = value(block, parent, "coordinates");
      const coords = coordText ? coordText.split(",").map(v => num(v.trim())) : [];
      const lonRaw = value(block, parent, "longitude", "EventLongitude", "Longitude");
      const latRaw = value(block, parent, "latitude", "EventLatitude", "Latitude");
      let lon = coords.length > 1 ? coords[0] : parseLon(lonRaw);
      let lat = coords.length > 1 ? coords[1] : parseLat(latRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const circle = value(block, parent, "circle");
        const m = circle.match(/(-?\d+(?:[.,]\d+)?)\s*,\s*(-?\d+(?:[.,]\d+)?)/);
        if (m) { lat = num(m[1]); lon = num(m[2]); }
      }
      const mag = num(value(block, parent, "magnitude", "EventMagnitude"));
      const depthRaw = value(block, parent, "depth", "EventDepth");
      const depth = depthRaw.match(/[0-9]+(?:[.,][0-9]+)?/)?.[0] || "—";
      const area = value(block, parent, "area", "EventLocationName", "ShortLocationName", "areaDesc") || "Indonesia";
      const eventid = value(block, parent, "eventid", "EventID", "identifier", "id") || [date, time, mag, lat, lon].join("|");
      const pdMatch = (subject + " " + headline + " " + description).match(/PD[-\s]?([\d.]+)/i);
      const pd = pdMatch ? pdMatch[1] : "";
      const potential = value(block, parent, "potential") || subject || headline;
      const instruction = value(block, parent, "instruction");
      const instruction1 = value(block, parent, "instruction1");
      const instruction2 = value(block, parent, "instruction2");
      const instruction3 = value(block, parent, "instruction3");
      const timesent = value(block, parent, "timesent", "sent", "updated", "published");
      // Preserve CAP lifecycle metadata so push senders can distinguish current
      // public warnings from historic or cancelled bulletins in the last-30 archive.
      const capStatus = value(block, parent, "status");
      const capMsgType = value(block, parent, "msgType", "messageType", "msgtype");
      const capScope = value(block, parent, "scope");
      const capExpires = value(block, parent, "expires");
      const capEffective = value(block, parent, "effective");
      const shakemap = value(block, parent, "shakemap");
      const wzmap = value(block, parent, "wzmap");
      const ttmap = value(block, parent, "ttmap");
      const sshmap = value(block, parent, "sshmap");
      const explicitBound = (...tags) => {
        for (const tag of tags) {
          const raw = value(block, parent, tag);
          if (raw) { const parsed = num(raw); if (Number.isFinite(parsed)) return parsed; }
        }
        return NaN;
      };
      const sshBoundsRaw = {
        minLat: explicitBound("sshminlat", "ssh_min_lat", "minLat", "min_lat"),
        minLon: explicitBound("sshminlon", "ssh_min_lon", "minLon", "min_lon"),
        maxLat: explicitBound("sshmaxlat", "ssh_max_lat", "maxLat", "max_lat"),
        maxLon: explicitBound("sshmaxlon", "ssh_max_lon", "maxLon", "max_lon")
      };
      const sshBounds = Object.values(sshBoundsRaw).every(Number.isFinite) &&
        sshBoundsRaw.minLat < sshBoundsRaw.maxLat && sshBoundsRaw.minLon < sshBoundsRaw.maxLon &&
        sshBoundsRaw.minLat >= -90 && sshBoundsRaw.maxLat <= 90 &&
        sshBoundsRaw.minLon >= -180 && sshBoundsRaw.maxLon <= 180 ? sshBoundsRaw : null;
      const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon) &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      if ((Number.isFinite(lat) && Math.abs(lat) > 90) ||
          (Number.isFinite(lon) && Math.abs(lon) > 180)) continue;
      // Do not drop a bulletin just because the XML omitted its coordinates.
      list.push({
        key: "tsun-" + eventid + "-" + (pd || list.length),
        eventid, magnitude: Number.isFinite(mag) ? mag : 0,
        lat: hasCoordinates ? lat : null, lon: hasCoordinates ? lon : null, depth,
        place: area, time: capEventTime(date, time), date, timeLocal: time,
        potential: potential || "Riwayat peringatan dini tsunami InaTEWS",
        subject: subject || ("WARNING TSUNAMI PD-" + (pd || "?")),
        pd: pd || null, headline, description, instruction, instruction1, instruction2, instruction3, timesent,
        capStatus: capStatus || null, capMsgType: capMsgType || null, capScope: capScope || null,
        expires: capExpires || null, effective: capEffective || null,
        shakemap: mapCapAsset(shakemap) || null,
        wzmap: mapCapAsset(wzmap), ttmap: mapCapAsset(ttmap), sshmap: mapCapAsset(sshmap),
        ...(sshBounds ? { sshBounds } : {}),
        ended: /telah\s*berakhir|berakhir|all[\s-]?clear|dinyatakan\s*telah\s*berakhir/i.test(headline + " " + description + " " + subject),
        source: "InaTEWS", isTsunamiWarning: true, official: true
      });
    }
  }
  // Preserve separate PD updates, de-duplicate exact duplicate XML records, and
  // keep the latest 30 bulletins in chronological order.
  const unique = new Map();
  for (const q of list) {
    const id = String(q.key || (q.eventid + "|" + q.pd));
    if (!unique.has(id)) unique.set(id, q);
  }
  return [...unique.values()]
    .sort((a,b) => new Date(b.timesent || b.time || 0) - new Date(a.timesent || a.time || 0))
    .slice(0, 30);
}
async function loadCachedTsunamiHistory(options) {
  return loadNormalizedFeed({
    ...options,
    name: "inatews-tsunami-history-v1",
    // The 30-bulletin archive changes far less often than the live earthquake feed.
    // Cache parsed bulletins so every 4-second browser poll does not re-run the XML parser.
    ttlMs: 30 * 1000,
    load: () => getText("https://cdn.bmkg.go.id/last30tsunamievent.xml", 4000, 30),
    map: parseTsunamiCapXml
  });
}

async function getText(url, timeoutMs = 4000, cacheTtlSeconds = 30) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/xml,text/xml,*/*", referer: "https://inatews.bmkg.go.id/web/tsunami" },
    cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true }
  });
  if (!res.ok) throw new Error("upstream HTTP " + res.status);
  return res.text();
}

async function getJson(url, live = false, timeoutMs = 4000, cacheTtlSeconds = 10) {
  const requestUrl = live ? url + (url.includes("?") ? "&" : "?") + "_wrs_ts=" + Date.now() : url;
  const res = await fetch(requestUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", ...(live ? { "cache-control": "no-cache" } : {}) },
    ...(live ? { cf: { cacheTtl: 0, cacheEverything: false } } : { cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true } })
  });
  if (!res.ok) throw new Error("upstream HTTP " + res.status);
  return res.json();
}

/*
 * BMKG menyediakan ketiga katalog gempa dalam JSON dan XML resmi.
 * Jika JSON sedang gagal dari edge Cloudflare, coba XML resmi sebelum
 * menyatakan sumber BMKG mati. Status sumber hanya dihitung berhasil jika
 * salah satu format benar-benar berhasil diambil dan diparse.
 */
function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function xmlTagValue(block, tag) {
  // Tag names passed here are fixed BMKG field names, so no regex escaping is needed.
  const pattern = "<(?:[A-Za-z0-9_.-]+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?" + tag + "\\s*>";
  const match = String(block ?? "").match(new RegExp(pattern, "i"));
  return match ? decodeXmlText(match[1].trim()) : "";
}
function parseBmkgEarthquakeXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("XML BMKG kosong");
  const blocks = xml.match(/<(?:[A-Za-z0-9_.-]+:)?gempa\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?gempa\s*>/gi) || [];
  if (!blocks.length) throw new Error("struktur XML BMKG tidak dikenali");
  return {
    Infogempa: {
      gempa: blocks.map(block => ({
        Tanggal: xmlTagValue(block, "Tanggal"),
        Jam: xmlTagValue(block, "Jam"),
        DateTime: xmlTagValue(block, "DateTime"),
        Coordinates: xmlTagValue(block, "coordinates"),
        Lintang: xmlTagValue(block, "Lintang"),
        Bujur: xmlTagValue(block, "Bujur"),
        Magnitude: xmlTagValue(block, "Magnitude"),
        Kedalaman: xmlTagValue(block, "Kedalaman"),
        Wilayah: xmlTagValue(block, "Wilayah"),
        Potensi: xmlTagValue(block, "Potensi"),
        Dirasakan: xmlTagValue(block, "Dirasakan"),
        Shakemap: xmlTagValue(block, "Shakemap")
      }))
    },
    _wrsFormat: "XML fallback"
  };
}
async function getBmkgFeed(jsonUrl) {
  let jsonError;
  try {
    // BMKG's public feeds are frequently rate-limited when polled by multiple
    // edge locations. Cache successful responses longer; this does not cache
    // the live InaTEWS lastQL stream, which uses its own no-cache request.
    const value = await getJson(jsonUrl, false, 3500, 60);
    const gempa = value?.Infogempa?.gempa;
    if (gempa && (Array.isArray(gempa) || typeof gempa === "object")) return value;
    jsonError = new Error("respons JSON tidak memiliki Infogempa.gempa");
  } catch (error) {
    jsonError = error;
  }
  // A 429 is an explicit rate-limit response. Immediately requesting the XML
  // sibling doubles traffic to the same BMKG service and often receives 429 too.
  // Back off instead; other independent sources continue to refresh normally.
  if (/upstream HTTP 429/.test(String(jsonError?.message || jsonError || ""))) {
    throw new Error("upstream HTTP 429 (BMKG rate limit; XML fallback dilewati agar tidak menambah beban)");
  }
  const xmlUrl = jsonUrl.replace(/\.json(?:\?.*)?$/i, ".xml");
  try {
    const xml = await getText(xmlUrl, 3500, 60);
    const parsed = parseBmkgEarthquakeXml(xml);
    parsed._wrsFallbackFrom = String(jsonError?.message || jsonError || "JSON gagal").slice(0, 100);
    return parsed;
  } catch (xmlError) {
    throw new Error("JSON gagal (" + String(jsonError?.message || jsonError || "error").slice(0, 90) +
      "); XML fallback gagal (" + String(xmlError?.message || xmlError || "error").slice(0, 90) + ")");
  }
}
function qlFeatures(value) {
  if (Array.isArray(value?.features)) return value.features;
  if (value?.type === "Feature") return [value];
  if (Array.isArray(value)) return value;
  return [];
}
async function handleEarthquakesRequest({ request, waitUntil, env } = {}) {
  // Share a single upstream refresh across clients in the same Cloudflare edge location.
  // The browser polls every 4s; a 10s freshness window lets overlapping polls and
  // nearby clients reuse the same response. The live InaTEWS lastQL feed is still
  // fetched without upstream caching on each actual edge refresh.
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  let edgeCacheKey = null;
  let staleEdgeData = null;
  let staleEdgeAgeSeconds = null;
  if (edgeCache && request?.url) {
    try {
      const cacheUrl = new URL(request.url);
      cacheUrl.search = "";
      cacheUrl.searchParams.set("_wrs_edge_cache", "v1");
      edgeCacheKey = new Request(cacheUrl.toString(), { method: "GET" });
      const cached = await edgeCache.match(edgeCacheKey);
      if (cached) {
        const cachedData = await cached.clone().json();
        const fetchedAtMs = Date.parse(cachedData?.fetchedAt || "");
        const ageMs = Date.now() - fetchedAtMs;
        if (cachedData?.ok === true && Array.isArray(cachedData.recent) && cachedData.recent.length &&
            Number.isFinite(fetchedAtMs) && ageMs >= 0) {
          // Serve the edge copy immediately only while it is genuinely fresh.
          if (ageMs <= 10000) {
            const cachedHeaders = new Headers(cached.headers);
            cachedHeaders.set("cache-control", "no-store");
            cachedHeaders.set("x-wrs-cache", "HIT");
            return new Response(JSON.stringify(cachedData), { status: 200, headers: cachedHeaders });
          }
          // Keep a last-known-good edge copy available while live feeds are checked.
          staleEdgeData = cachedData;
          staleEdgeAgeSeconds = Math.floor(ageMs / 1000);
        }
      }
    } catch (_) { /* Cache API is optional; continue with live upstream requests. */ }
  }
  const validEventTime = value => {
    const t = new Date(value || 0).getTime();
    return Number.isFinite(t) && t > 0 ? t : NaN;
  };
  const distanceKm = (a, b) => {
    const rad = n => n * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
  };
  const errors=[];
  const [results, historyQL, usgs, usgsIndonesia, tsunamiFeed, ptwcFeed, ntwcFeed] = await Promise.all([
    Promise.allSettled([
      ...BMKG_URLS.map(url=>getBmkgFeed(url)),
      // This live feed remains uncached and is checked on every actual edge refresh.
      getJson(GCS+"/lastQL.json", true, 3500)
    ]),
    // Historical and global catalogues are normalized once per cache window;
    // these caches avoid repeatedly parsing large feeds on each catalogue poll.
    loadCachedHistoryEvents({ cache: edgeCache, request }),
    loadCachedUSGSEvents({ cache: edgeCache, request }),
    // Independent 72-hour regional search can supplement missing BMKG/InaTEWS entries.
    loadCachedUSGSIndonesiaEvents({ cache: edgeCache, request }),
    // InaTEWS history is kept separate from currently issued international messages.
    loadCachedTsunamiHistory({ cache: edgeCache, request }),
    loadCachedGlobalTsunamiFeed({ cache: edgeCache, request }, "PTWC", "https://www.tsunami.gov/events/xml/PHEBAtom.xml"),
    loadCachedGlobalTsunamiFeed({ cache: edgeCache, request }, "NTWC", "https://www.tsunami.gov/events/xml/PAAQAtom.xml")
  ]);
  const list=[];
  const qlEvents=[];
  const bmkgFeedNames = ["BMKG autogempa.json", "BMKG gempaterkini.json", "BMKG gempadirasakan.json"];
  results.slice(0,3).forEach((r,i)=>{
    if(r.status!=="fulfilled"){errors.push(bmkgFeedNames[i] + " gagal diakses: " + String(r.reason?.message || "permintaan gagal").slice(0,180));return;}
    const g=r.value?.Infogempa?.gempa;
    (Array.isArray(g)?g:g?[g]:[]).forEach(x=>{const q=mapPublic(x);if(q)list.push(q);});
  });
  // lastQL.json adalah feed realtime terbaru; gempaQL.json adalah katalog/riwayat.
  const ql=results[3];
  const liveQL = ql.status === "fulfilled" ? qlFeatures(ql.value).map(mapQL).filter(Boolean) : [];
  if (ql.status !== "fulfilled") errors.push("InaTEWS lastQL");
  // Bound historical and global raw records before mapping/sorting. Keep the live
  // lastQL stream intact, while preventing large catalogues from consuming the
  // Pages Function CPU budget and turning the endpoint into HTTP 503.
  const historyEvents = historyQL.status === "fulfilled" ? historyQL.value : [];
  if (historyQL.status !== "fulfilled") {
    errors.push("InaTEWS gempaQL: " + String(historyQL.reason?.message || "katalog riwayat tidak tersedia").slice(0, 180));
  } else if (historyQL.stale) {
    errors.push("InaTEWS gempaQL: memakai cache riwayat (" + historyQL.cacheAgeSeconds +
      " detik); pembaruan gagal: " + String(historyQL.sourceError || "sumber sementara gagal").slice(0, 120));
  }
  liveQL.forEach(q => {
    q.source = "InaTEWS WRS";
    q.wrsRealtime = true;
    // InaTEWS lastQL can occasionally publish a rounded/incorrect depth compared
    // with BMKG's public earthquake bulletin. When both feeds clearly describe
    // the same event, retain the live WRS event but use BMKG's reported depth.
    const qTime = validEventTime(q.time);
    // Rank all plausible BMKG matches rather than taking the first catalogue item.
    // A matching event must agree in time, epicentre and magnitude; never copy depth
    // from a nearby but different earthquake.
    const bmkgMatch = list
      .filter(b => {
        if (b.source !== "BMKG" || !b.official ||
            !Number.isFinite(b.lat) || !Number.isFinite(b.lon) ||
            !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) return false;
        const bTime = validEventTime(b.time);
        if (!Number.isFinite(qTime) || !Number.isFinite(bTime)) return false;
        return Math.abs(qTime - bTime) <= 2 * 60 * 1000 &&
          distanceKm(q, b) <= 20 &&
          Math.abs(Number(q.magnitude) - Number(b.magnitude)) <= 0.4;
      })
      .map(b => ({
        event: b,
        score: Math.abs(validEventTime(b.time) - qTime) / 120000 +
          distanceKm(q, b) / 20 +
          Math.abs(Number(q.magnitude) - Number(b.magnitude)) / 0.4
      }))
      .sort((a, b) => a.score - b.score)[0]?.event;
    if (bmkgMatch) {
      const officialDepth = Number(String(bmkgMatch.depth ?? "").replace(",", "."));
      if (String(bmkgMatch.depth ?? "").trim() !== "" &&
          Number.isFinite(officialDepth) && officialDepth >= 0) {
        q.depth = String(officialDepth);
        q.depthSource = "BMKG";
      }
      // Put the official BMKG region in the shared event field so web and APK
      // render the same place name, while retaining the live WRS source label.
      if (bmkgMatch.place) q.place = bmkgMatch.place;
    }
    list.push(q);
  });
  historyEvents.forEach(q => { q.source = "InaTEWS"; q.wrsRealtime = false; list.push(q); });
  qlEvents.push(...liveQL);
  // Jangan pernah menyamarkan katalog historis sebagai feed realtime bila lastQL gagal/kosong.
  // These events are already normalized and served from a short-lived edge cache.
  // A temporary global-feed outage must not force a full catalogue rebuild failure.
  if(usgs.status === "fulfilled") {
    usgs.value.forEach(q => list.push(q));
    if (usgs.stale) {
      errors.push("USGS global: memakai cache sebelumnya (" + usgs.cacheAgeSeconds +
        " detik); pembaruan gagal: " + String(usgs.sourceError || "sumber sementara gagal").slice(0, 120));
    }
  } else {
    errors.push("USGS global: " + String(usgs.reason?.message || "permintaan gagal").slice(0,120));
  }
  if (usgsIndonesia.status === "fulfilled") {
    usgsIndonesia.value.forEach(q => list.push(q));
    if (usgsIndonesia.stale) {
      errors.push("USGS Indonesia: memakai cache sebelumnya (" + usgsIndonesia.cacheAgeSeconds +
        " detik); pembaruan gagal: " + String(usgsIndonesia.sourceError || "sumber sementara gagal").slice(0, 120));
    }
  } else {
    errors.push("USGS Indonesia: " + String(usgsIndonesia.reason?.message || "permintaan gagal").slice(0,120));
  }
  // Jangan menunggu permintaan detail ShakeMap USGS untuk mengirim katalog.
  // Peta USGS dimuat on-demand ketika pengguna membuka detail event; ini menjaga
  // polling operasional tetap cepat dan tidak membebani feed pada setiap refresh.
  const tsunami = tsunamiFeed;
  let tsunamiHistory = tsunami.status === "fulfilled" && Array.isArray(tsunami.value) ? tsunami.value : [];
  if (tsunami.status !== "fulfilled") {
    errors.push("InaTEWS tsunami: " + String(tsunami.reason?.message || "riwayat sementara tidak tersedia").slice(0, 180));
  } else if (tsunami.stale) {
    errors.push("InaTEWS tsunami: memakai cache sebelumnya (" + tsunami.cacheAgeSeconds +
      " detik); pembaruan gagal: " + String(tsunami.sourceError || "sumber sementara gagal").slice(0, 120));
  }
  // Riwayat dari feed yang parsial tidak boleh menghapus buletin lama yang masih
  // tersimpan. Gabungkan berdasarkan identitas buletin (event + PD), urut terbaru,
  // lalu batasi ke 30. Arsip ini TIDAK menentukan apakah peringatan sedang aktif.
  if (staleEdgeData?.tsunamiHistory?.length) {
    const merged = new Map();
    for (const q of [...tsunamiHistory, ...staleEdgeData.tsunamiHistory]) {
      if (!q || typeof q !== "object") continue;
      const id = String(q.key || (String(q.eventid || "") + "|" + String(q.pd || q.subject || "")));
      if (!id) continue;
      const prev = merged.get(id);
      if (!prev || new Date(q.timesent || q.time || 0).getTime() > new Date(prev.timesent || prev.time || 0).getTime()) merged.set(id, q);
    }
    const liveHistoryCount = tsunamiHistory.length;
    tsunamiHistory = [...merged.values()]
      .sort((a,b) => new Date(b.timesent || b.time || 0).getTime() - new Date(a.timesent || a.time || 0).getTime())
      .slice(0, 30);
    if (liveHistoryCount < 30 && staleEdgeData.tsunamiHistory.length > liveHistoryCount) {
      errors.push("InaTEWS tsunami: riwayat parsial digabung dengan arsip terakhir tersimpan");
    }
  }
  // Global warning-center messages are supplementary context, not proof of a warning for Indonesia.
  // The app shows the centers' latest messages and links instead of deriving an active warning from earthquake magnitude.
  const ptwcMessages = ptwcFeed.status === "fulfilled" ? ptwcFeed.value : [];
  const ntwcMessages = ntwcFeed.status === "fulfilled" ? ntwcFeed.value : [];
  const globalTsunamiMessages = [...ptwcMessages, ...ntwcMessages]
    .sort((a, b) => (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0))
    .slice(0, 12);
  const feedSourceState = (result) => ({
    ok: result.status === "fulfilled" && result.stale !== true,
    cached: result.status === "fulfilled" && result.stale === true,
    count: result.status === "fulfilled" && Array.isArray(result.value) ? result.value.length : 0,
    error: result.status === "rejected" ? String(result.reason?.message || "feed sementara tidak tersedia").slice(0, 160) : null
  });
  const globalTsunamiSources = { ptwc: feedSourceState(ptwcFeed), ntwc: feedSourceState(ntwcFeed) };

  // Prioritaskan data resmi BMKG, lalu feed WRS live, katalog InaTEWS, dan USGS.
  const eventPriority = q => q.source === "BMKG" && q.official ? 4 :
    q.source === "InaTEWS WRS" ? 3 : q.source === "InaTEWS" ? 2 : q.source === "USGS" ? 1 : 0;
  const validTime = q => {
    const t = new Date(q.time || 0).getTime();
    return Number.isFinite(t) && t > 0 ? t : NaN;
  };
  const sameEvent = (a, b) => {
    if (a.key === b.key) return true;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;
    const ta = validTime(a), tb = validTime(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
    const sameCatalog = a.source === b.source;
    const timeWindow = sameCatalog && a.source === "BMKG" ? 90_000 : 4 * 60_000;
    const distanceWindow = sameCatalog && a.source === "BMKG" ? 12 : 35;
    const magnitudeWindow = sameCatalog && a.source === "BMKG" ? 0.3 : 0.7;
    return Math.abs(ta - tb) <= timeWindow &&
      distanceKm(a, b) <= distanceWindow &&
      Math.abs(Number(a.magnitude) - Number(b.magnitude)) <= magnitudeWindow;
  };
  // Deduplicate using a time index rather than scanning the entire catalogue for
  // every event. The old O(n²) scan could consume too much edge CPU when BMKG, WRS,
  // USGS global and USGS Indonesia all returned large catalogues, causing intermittent
  // API 503s even though the upstream feeds themselves were reachable.
  const unique = new Set();
  const bucketWidthMs = 4 * 60 * 1000;
  const timeBuckets = new Map();
  const bucketFor = q => {
    const t = validTime(q);
    return Number.isFinite(t) ? Math.floor(t / bucketWidthMs) : null;
  };
  const addToTimeIndex = q => {
    const bucket = bucketFor(q);
    if (bucket === null) return;
    if (!timeBuckets.has(bucket)) timeBuckets.set(bucket, []);
    timeBuckets.get(bucket).push(q);
  };
  const removeFromTimeIndex = q => {
    const bucket = bucketFor(q);
    if (bucket === null) return;
    const entries = timeBuckets.get(bucket);
    if (!entries) return;
    const index = entries.indexOf(q);
    if (index >= 0) entries.splice(index, 1);
    if (!entries.length) timeBuckets.delete(bucket);
  };
  list.sort((a,b) => {
    const ta = validTime(a), tb = validTime(b);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  }).forEach(q => {
    const bucket = bucketFor(q);
    const candidates = [];
    if (bucket !== null) {
      // A four-minute match window can cross at most one adjacent bucket on either side.
      for (let b = bucket - 1; b <= bucket + 1; b++) {
        const entries = timeBuckets.get(b);
        if (entries) candidates.push(...entries);
      }
    }
    const matches = candidates.filter(item => sameEvent(item, q));
    if (!matches.length) {
      unique.add(q);
      addToTimeIndex(q);
      return;
    }

    // Keep one record per event: official BMKG first, live InaTEWS next, USGS last.
    // Merge all matching duplicates, even when the current item is lower priority.
    let winner = matches[0];
    for (const candidate of matches.slice(1)) {
      if (eventPriority(candidate) > eventPriority(winner)) winner = candidate;
    }
    if (eventPriority(q) > eventPriority(winner)) winner = q;

    for (const match of matches) {
      removeFromTimeIndex(match);
      unique.delete(match);
    }
    unique.add(winner);
    addToTimeIndex(winner);
  });
  const recent=[...unique].sort((a,b)=>validTime(b)-validTime(a)).slice(0,800);
  const inIndonesia = q => q.lat >= -11 && q.lat <= 6.5 && q.lon >= 94 && q.lon <= 141.5;
  const official=recent.find(q=>q.source === "BMKG" && q.official && inIndonesia(q)) ||
    recent.find(q=>q.official) || null;
  // Keep the WRS/InaTEWS realtime stream separate from the merged catalog.
  // The catalog deduplicates records and prefers BMKG; it must not replace the WRS event.
  // realtimeEvents hanya boleh berisi feed lastQL live. Katalog gempaQL
  // tidak boleh dipakai sebagai pengganti diam-diam ketika feed live kosong.
  const realtimeEvents=liveQL
    .filter(q=>Number.isFinite(validTime(q)) && inIndonesia(q))
    .sort((a,b)=>validTime(b)-validTime(a))
    .filter((q,index,all)=>all.findIndex(item=>item.key===q.key)===index);
  const liveEvents=liveQL
    .filter(q=>Number.isFinite(validTime(q)) && inIndonesia(q))
    .sort((a,b)=>validTime(b)-validTime(a));
  const realtime=liveEvents[0] || null;
  // If every earthquake feed failed, or the combined catalogue suddenly becomes empty,
  // serve the last known good catalogue instead of making the monitor appear to go blank.
  const anyQuakeSourceAvailable = results.slice(0, 4).some(r => r.status === "fulfilled") ||
    historyQL.status === "fulfilled" || usgs.status === "fulfilled" ||
    usgsIndonesia.status === "fulfilled";
  if (staleEdgeData && staleEdgeData.recent?.length &&
      (!anyQuakeSourceAvailable || recent.length === 0)) {
    const fallback = {
      ...staleEdgeData,
      ok: true,
      sources: {
        ...(staleEdgeData.sources || {}),
        wrs: { ...(staleEdgeData.sources?.wrs || {}), ok: false, error: "Feed realtime belum dapat diverifikasi; memakai katalog tersimpan" },
        staleCache: true,
        staleAgeSeconds: staleEdgeAgeSeconds,
        errors: [...new Set([...(errors || []), "Feed gempa sementara tidak tersedia; katalog terakhir dipertahankan"])]
      }
    };
    const fallbackHeaders = new Headers(headers);
    fallbackHeaders.set("cache-control", "no-store");
    fallbackHeaders.set("x-wrs-cache", "STALE");
    fallbackHeaders.set("x-wrs-data-age-seconds", String(staleEdgeAgeSeconds ?? ""));
    return new Response(JSON.stringify(fallback), { status: 200, headers: fallbackHeaders });
  }
  const response = new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:8,latest:realtime||official||recent[0]||null,realtime,realtimeEvents,official,recent,count:recent.length,tsunamiHistory,globalTsunamiMessages,globalTsunamiSources,sources:{wrs:{ok:ql.status==="fulfilled",eventCount:liveEvents.length,checkedAt:new Date().toISOString(),error:ql.status==="rejected"?String(ql.reason?.message||"Feed InaTEWS lastQL gagal diakses"):null},wrsHistory:{ok:historyQL.status==="fulfilled",eventCount:historyEvents.length,error:historyQL.status==="rejected"?String(historyQL.reason?.message||"Feed InaTEWS gempaQL gagal diakses"):historyQL.stale?("Cache riwayat digunakan; refresh gagal: "+String(historyQL.sourceError||"sumber sementara gagal")):null,cached:historyQL.cacheHit===true,cacheAgeSeconds:historyQL.cacheAgeSeconds??null},public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:historyEvents.length,usgs:recent.filter(q=>q.source==="USGS").length,usgsGlobal:usgs.status==="fulfilled"?usgs.value.length:0,usgsIndonesia:usgsIndonesia.status==="fulfilled"?usgsIndonesia.value.length:0,tsunami:tsunamiHistory.length,globalTsunami:globalTsunamiSources,client:false,errors}}),{status:200,headers});
  if (edgeCache && edgeCacheKey) {
    try {
      const cacheHeaders = new Headers(response.headers);
      // Retain the last known-good payload for recovery, but the handler above
      // only serves it as fresh for 10 seconds; older copies are fallback-only.
      cacheHeaders.set("cache-control", "public, max-age=900");
      cacheHeaders.set("x-wrs-cache", "MISS");
      const cacheResponse = new Response(response.clone().body, { status: response.status, headers: cacheHeaders });
      await scheduleCacheTask(edgeCache.put(edgeCacheKey, cacheResponse), waitUntil, "edge last-good");
    } catch (cacheError) {
      console.warn("[WRS API] Edge cache write skipped:",
        String(cacheError?.message || cacheError).slice(0, 120));
    }
  }

  // Save only a normal full catalogue, never an emergency/partial response.
  // This shared, dedicated KV fallback survives when requests land on another edge.
  const durableWrite = response.clone().json()
    .then(payload => writeDurableLastGood(env, payload))
    .catch(error => console.warn("[WRS API] Durable cache scheduling failed:",
      String(error?.message || error).slice(0, 120)));
  await scheduleCacheTask(durableWrite, waitUntil, "durable last-good");
  return response;
}


// Fail-safe for unexpected handler exceptions: serve the last known-good API
// payload with an explicit stale marker rather than letting one transient
// exception blank the WRS screen with an HTTP 5xx. This does not fabricate data.
export async function onRequestGet(context = {}) {
  try {
    return await handleEarthquakesRequest(context);
  } catch (error) {
    // Keep a stack trace in Cloudflare Pages Functions logs so intermittent
    // HTTP 503 responses can be tied to the actual server-side exception.
    console.error("[WRS API] Unexpected earthquake handler failure:", error);
    const request = context.request;
    const edgeCache = typeof caches !== "undefined" ? caches.default : null;
    if (edgeCache && request?.url) {
      try {
        const cacheUrl = new URL(request.url);
        cacheUrl.search = "";
        cacheUrl.searchParams.set("_wrs_edge_cache", "v1");
        const cached = await edgeCache.match(new Request(cacheUrl.toString(), { method: "GET" }));
        if (cached) {
          const data = await cached.json();
          if (data?.ok === true && Array.isArray(data.recent) && data.recent.length) {
            const oldFetch = Date.parse(data.fetchedAt || "");
            const age = Number.isFinite(oldFetch) ? Math.max(0, Math.floor((Date.now() - oldFetch) / 1000)) : null;
            data.sources = {
              ...(data.sources || {}),
              staleCache: true,
              staleAgeSeconds: age,
              errors: [...new Set([...(data.sources?.errors || []), "API internal sementara gagal; data terakhir yang tersimpan dipertahankan"])]
            };
            const responseHeaders = new Headers(headers);
            responseHeaders.set("x-wrs-cache", "STALE-ERROR-FALLBACK");
            responseHeaders.set("x-wrs-data-age-seconds", age == null ? "unknown" : String(age));
            return new Response(JSON.stringify(data), { status: 200, headers: responseHeaders });
          }
        }
      } catch (_) { /* No usable last-known-good response. */ }
    }
    // If this edge has no usable local cache, read the last successful full
    // catalogue from a dedicated KV namespace. It is only served during an
    // exception and only while recent enough; live requests still refresh normally.
    const durable = await readDurableLastGood(context?.env);
    if (durable) {
      const data = durable.payload;
      data.sources = {
        ...(data.sources || {}),
        staleCache: true,
        durableStaleCache: true,
        staleAgeSeconds: durable.ageSeconds,
        errors: [...new Set([
          ...(Array.isArray(data.sources?.errors) ? data.sources.errors : []),
          "API utama sementara gagal; katalog lengkap terakhir dipertahankan dari cache bersama"
        ])]
      };
      const durableHeaders = new Headers(headers);
      durableHeaders.set("cache-control", "no-store");
      durableHeaders.set("x-wrs-cache", "DURABLE-STALE-FALLBACK");
      durableHeaders.set("x-wrs-data-age-seconds", String(durable.ageSeconds));
      console.warn("[WRS API] Durable last-good catalogue served after handler failure", {
        ageSeconds: durable.ageSeconds,
        eventCount: data.recent.length,
        cause: String(error?.message || error).slice(0, 120)
      });
      return new Response(JSON.stringify(data), { status: 200, headers: durableHeaders });
    }

    // Emergency recovery: if neither local edge cache nor shared last-good data
    // exists, rebuild a SMALL response from the primary BMKG/InaTEWS feeds.
    // Optional history/global sources must not make the core monitor return 503.
    try {
      const emergencyResults = await Promise.allSettled([
        ...BMKG_URLS.map(url => getBmkgFeed(url)),
        getJson(GCS + "/lastQL.json", true, 2500),
        // Reuse the normalized global cache in the emergency path too; avoid
        // parsing the entire weekly USGS GeoJSON again while recovering.
        loadCachedUSGSEvents({ cache: edgeCache, request }),
        loadCachedUSGSIndonesiaEvents({ cache: edgeCache, request })
      ]);
      const emergencyEvents = [];
      let bmkgOk = 0;
      emergencyResults.slice(0, 3).forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        bmkgOk++;
        const raw = result.value?.Infogempa?.gempa;
        (Array.isArray(raw) ? raw : raw ? [raw] : []).forEach(item => {
          try {
            const event = mapPublic(item);
            if (event) emergencyEvents.push(event);
          } catch (mapError) {
            console.warn("[WRS API] Emergency BMKG event skipped:", String(mapError?.message || mapError).slice(0, 120));
          }
        });
      });
      const liveResult = emergencyResults[3];
      const liveEvents = liveResult.status === "fulfilled"
        ? qlFeatures(liveResult.value).map(item => {
            try {
              const event = mapQL(item);
              if (event) {
                event.source = "InaTEWS WRS";
                event.wrsRealtime = true;
                return event;
              }
            } catch (mapError) {
              console.warn("[WRS API] Emergency InaTEWS event skipped:", String(mapError?.message || mapError).slice(0, 120));
            }
            return null;
          }).filter(Boolean)
        : [];
      const usgsResult = emergencyResults[4];
      let usgsEmergencyCount = 0;
      const cachedUSGS = usgsResult.status === "fulfilled" ? usgsResult.value : null;
      if (cachedUSGS?.status === "fulfilled" && Array.isArray(cachedUSGS.value)) {
        cachedUSGS.value.forEach(event => {
          emergencyEvents.push(event);
          usgsEmergencyCount++;
        });
      } else {
        const reason = cachedUSGS?.reason || usgsResult.reason || "USGS global cache/feed tidak tersedia";
        console.warn("[WRS API] Emergency USGS global feed failed:", String(reason?.message || reason).slice(0, 120));
      }
      const usgsIndonesiaResult = emergencyResults[5];
      let usgsIndonesiaEmergencyCount = 0;
      const cachedUSGSIndonesia = usgsIndonesiaResult?.status === "fulfilled" ? usgsIndonesiaResult.value : null;
      if (cachedUSGSIndonesia?.status === "fulfilled" && Array.isArray(cachedUSGSIndonesia.value)) {
        cachedUSGSIndonesia.value.forEach(event => {
          emergencyEvents.push(event);
          usgsIndonesiaEmergencyCount++;
        });
      } else {
        const reason = cachedUSGSIndonesia?.reason || usgsIndonesiaResult?.reason || "USGS Indonesia cache/feed tidak tersedia";
        console.warn("[WRS API] Emergency USGS Indonesia feed failed:", String(reason?.message || reason).slice(0, 120));
      }
      const inIndonesia = event => Number.isFinite(event.lat) && Number.isFinite(event.lon) &&
        event.lat >= -11 && event.lat <= 6.5 && event.lon >= 94 && event.lon <= 141.5;
      emergencyEvents.push(...liveEvents);
      const deduped = new Map();
      emergencyEvents.forEach(event => {
        const id = String(event.key || [event.source, event.time, event.lat, event.lon, event.magnitude].join("|"));
        if (!deduped.has(id)) deduped.set(id, event);
      });
      const recent = [...deduped.values()]
        .sort((a, b) => (Date.parse(b.time || "") || 0) - (Date.parse(a.time || "") || 0))
        .slice(0, 800);
      if (recent.length) {
        const realtimeEvents = liveEvents.filter(inIndonesia)
          .sort((a, b) => (Date.parse(b.time || "") || 0) - (Date.parse(a.time || "") || 0));
        const realtime = realtimeEvents[0] || null;
        const official = recent.find(event => event.source === "BMKG" && event.official && inIndonesia(event)) ||
          recent.find(event => event.official) || null;
        const failure = String(error?.message || error).slice(0, 160);
        const payload = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          refreshSeconds: 8,
          latest: realtime || official || recent[0] || null,
          realtime,
          realtimeEvents,
          official,
          recent,
          count: recent.length,
          // Do not replace a user's saved 30-bulletin archive with a fabricated or
          // empty history. The client merges this empty emergency array with its
          // locally persisted archive; normal responses still supply server history.
          tsunamiHistory: [],
          sources: {
            wrs: {
              ok: liveResult.status === "fulfilled",
              eventCount: realtimeEvents.length,
              checkedAt: new Date().toISOString(),
              error: liveResult.status === "rejected" ? String(liveResult.reason?.message || "InaTEWS realtime gagal") : null
            },
            wrsHistory: { ok: false, eventCount: 0, error: "Katalog riwayat tidak dimuat pada pemulihan darurat" },
            public: bmkgOk,
            publicEvents: recent.filter(event => event.source === "BMKG").length,
            inaQL: 0,
            usgs: usgsEmergencyCount + usgsIndonesiaEmergencyCount,
            usgsGlobal: usgsEmergencyCount,
            usgsIndonesia: usgsIndonesiaEmergencyCount,
            tsunami: 0,
            emergencyFallback: true,
            errors: ["API utama mengalami gangguan internal; memakai respons darurat BMKG/InaTEWS", "Detail gangguan: " + failure]
          }
        };
        const recoveryHeaders = new Headers(headers);
        recoveryHeaders.set("cache-control", "no-store");
        recoveryHeaders.set("x-wrs-cache", "EMERGENCY-FALLBACK");

        // A successful emergency response is still a valid last-known-good
        // catalogue. Persist it so the next poll does not repeat the expensive
        // recovery sequence and risk another HTTP 503 during the same outage.
        // The payload remains explicitly marked emergencyFallback; this cache
        // must never make partial data look like a fully healthy API response.
        const recoveryBody = JSON.stringify(payload);
        if (edgeCache && request?.url) {
          try {
            const cacheUrl = new URL(request.url);
            cacheUrl.search = "";
            cacheUrl.searchParams.set("_wrs_edge_cache", "v1");
            const recoveryKey = new Request(cacheUrl.toString(), { method: "GET" });
            const cacheHeaders = new Headers(recoveryHeaders);
            cacheHeaders.set("cache-control", "public, max-age=900");
            cacheHeaders.set("x-wrs-cache", "EMERGENCY-FALLBACK");
            const cacheWrite = edgeCache.put(recoveryKey, new Response(recoveryBody, {
              status: 200,
              headers: cacheHeaders
            }));
            if (typeof context.waitUntil === "function") context.waitUntil(cacheWrite);
            else await cacheWrite;
          } catch (cacheError) {
            console.warn("[WRS API] Emergency fallback cache write failed:", String(cacheError?.message || cacheError).slice(0, 120));
          }
        }

        console.error("[WRS API] Emergency core-feed fallback served", {
          bmkgFeedsOk: bmkgOk,
          liveInaTEWSOk: liveResult.status === "fulfilled",
          usgsGlobalEvents: usgsEmergencyCount,
          usgsIndonesiaEvents: usgsIndonesiaEmergencyCount,
          eventCount: recent.length,
          cause: failure
        });
        return new Response(recoveryBody, { status: 200, headers: recoveryHeaders });
      }
    } catch (fallbackError) {
      console.error("[WRS API] Emergency core-feed fallback failed:", fallbackError);
    }
    return new Response(JSON.stringify({
      ok: false,
      error: "API gempa sementara tidak tersedia",
      fetchedAt: null,
      sources: { errors: ["API internal sementara gagal: " + String(error?.message || error).slice(0, 160)] }
    }), { status: 503, headers });
  }
}
