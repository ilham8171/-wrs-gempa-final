const BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const WRS_LIVE_URL = "https://bmkg-content-inatews.storage.googleapis.com/lastQL.json";
const USGS_GLOBAL_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson";
const USGS_ALL_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
const TSUNAMI_URL = "https://cdn.bmkg.go.id/last30tsunamievent.xml";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};
const num = value => {
  const n = Number(String(value ?? "").replace(/,/g, ".").trim());
  return Number.isFinite(n) ? n : NaN;
};
const text = (...values) => {
  for (const value of values) {
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
};
function parseLat(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  const match = raw.match(/[+-]?\d+(?:[.,]\d+)?/);
  if (!match) return NaN;
  const n = num(match[0]);
  if (!Number.isFinite(n)) return NaN;
  if (/LS|\bS\b/i.test(raw)) return -Math.abs(n);
  if (/LU|\bN\b/i.test(raw)) return Math.abs(n);
  return n;
}
function parseLon(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  const match = raw.match(/[+-]?\d+(?:[.,]\d+)?/);
  if (!match) return NaN;
  const n = num(match[0]);
  if (!Number.isFinite(n)) return NaN;
  if (/BB|\bW\b/i.test(raw)) return -Math.abs(n);
  if (/BT|\bE\b/i.test(raw)) return Math.abs(n);
  return n;
}
function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
function mapBmkg(raw) {
  if (!raw) return null;
  const coordinateText = text(raw.Coordinates, raw.coordinates);
  const coords = coordinateText.split(",");
  let lat = coords.length > 1 ? parseLat(coords[0]) : NaN;
  let lon = coords.length > 1 ? parseLon(coords[1]) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const latToken = coordinateText.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:LS|LU|S|N)\b/i)?.[0];
    const lonToken = coordinateText.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:BT|BB|E|W)\b/i)?.[0];
    if (!Number.isFinite(lat) && latToken) lat = parseLat(latToken);
    if (!Number.isFinite(lon) && lonToken) lon = parseLon(lonToken);
  }
  if (!Number.isFinite(lat)) lat = parseLat(raw.Lintang);
  if (!Number.isFinite(lon)) lon = parseLon(raw.Bujur);
  const magnitude = num(raw.Magnitude ?? raw.magnitude);
  if (!Number.isFinite(magnitude) || !validCoordinates(lat, lon)) return null;
  const time = text(raw.DateTime, raw.datetime, raw.Tanggal && raw.Jam ? raw.Tanggal + " " + raw.Jam : "");
  const depth = text(raw.Kedalaman, raw.depth).match(/[0-9]+(?:[.,][0-9]+)?/)?.[0] || "—";
  return {
    key: "bmkg|" + (time || text(raw.Tanggal, "") + "|" + text(raw.Jam, "") + "|" + magnitude),
    magnitude,
    lat,
    lon,
    place: text(raw.Wilayah, raw.place, "Indonesia"),
    depth,
    time,
    potential: text(raw.Potensi, raw.potential, "—"),
    felt: text(raw.Dirasakan, raw.felt),
    source: "BMKG",
    status: "BMKG",
    official: true,
    shakemap: text(raw.Shakemap, raw.shakemap)
  };
}
function isoTime(value) {
  if (value == null || value === "") return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
function featureList(value) {
  if (Array.isArray(value?.features)) return value.features;
  if (value?.type === "Feature") return [value];
  if (Array.isArray(value)) return value;
  return [];
}
function mapWrsFeature(feature) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const magnitude = num(props.mag ?? props.magnitude);
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  if (!Number.isFinite(magnitude) || magnitude < 1.5 || !validCoordinates(lat, lon)) return null;
  return {
    key: "ql|" + text(props.id, props.time + "|" + lat + "|" + lon),
    eventid: text(props.id, props.time + "|" + lat + "|" + lon),
    magnitude,
    lat,
    lon,
    place: text(props.place, "Indonesia"),
    depth: text(props.depth, coords[2], "—"),
    time: isoTime(props.time),
    potential: "—",
    felt: "",
    source: "InaTEWS",
    status: "M",
    wrsRealtime: true
  };
}
function mapUsgsFeature(feature, minimumMagnitude) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const magnitude = num(props.mag);
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  if (!Number.isFinite(magnitude) || magnitude < minimumMagnitude || !validCoordinates(lat, lon)) return null;
  const tsunamiFlag = Number(props.tsunami) === 1;
  return {
    key: "usgs|" + text(feature.id, props.code, props.time),
    eventid: text(feature.id, ""),
    magnitude: Math.round(magnitude * 10) / 10,
    lat,
    lon,
    place: text(props.place, "Gempa global"),
    depth: text(coords[2], "—"),
    time: isoTime(props.time),
    potential: tsunamiFlag ? "USGS menandai event terkait tsunami — periksa buletin resmi" : "—",
    felt: "",
    source: "USGS",
    status: "USGS",
    official: false,
    usgsTsunamiFlag: tsunamiFlag,
    shakemap: null
  };
}
async function fetchJson(url, label, timeoutMs = 4500, cacheSeconds = 15, live = false) {
  const requestUrl = live
    ? url + (url.includes("?") ? "&" : "?") + "_wrs_push=" + Date.now()
    : url;
  const result = await fetch(requestUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json",
      ...(live ? { "cache-control": "no-cache, no-store", pragma: "no-cache" } : {})
    },
    cf: live ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: cacheSeconds, cacheEverything: true }
  });
  if (!result.ok) throw new Error(label + " HTTP " + result.status);
  return result.json();
}
async function fetchUsgsGlobal() {
  try {
    const primary = await fetchJson(USGS_GLOBAL_URL, "USGS global M4.5+", 5000, 30);
    if (!Array.isArray(primary?.features)) throw new Error("USGS 4.5+ response has no feature list");
    return { ...primary, features: primary.features.filter(feature => Number(feature?.properties?.mag) >= 5) };
  } catch (primaryError) {
    const fallback = await fetchJson(USGS_ALL_URL, "USGS all-week fallback", 6500, 30);
    if (!Array.isArray(fallback?.features)) {
      throw new Error("USGS primary failed (" + String(primaryError?.message || primaryError).slice(0, 90) +
        "); fallback has no feature list");
    }
    return { ...fallback, features: fallback.features.filter(feature => Number(feature?.properties?.mag) >= 5) };
  }
}
async function fetchTsunamiXml() {
  const result = await fetch(TSUNAMI_URL, {
    signal: AbortSignal.timeout(4500),
    headers: { accept: "application/xml,text/xml,*/*", referer: "https://inatews.bmkg.go.id/web/tsunami" },
    cf: { cacheTtl: 10, cacheEverything: true }
  });
  if (!result.ok) throw new Error("InaTEWS tsunami HTTP " + result.status);
  return result.text();
}
function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function xmlValue(block, tag) {
  const expression = new RegExp("<(?:[\\w.-]+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + tag + "\\s*>", "i");
  const match = String(block ?? "").match(expression);
  return match ? decodeXml(match[1].trim()) : "";
}
function eventTimeFromCap(dateValue, timeValue, originValue) {
  const rawOrigin = text(originValue);
  if (rawOrigin) {
    const parsed = Date.parse(rawOrigin);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const date = text(dateValue).replace(/\s+/g, "");
  const time = text(timeValue).replace(/\s*(WIB|UTC|GMT)\s*/ig, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) {
    const normalizedTime = time.length === 5 ? time + ":00" : time;
    const parsed = Date.parse(date + "T" + normalizedTime + "+07:00");
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return text(dateValue, timeValue);
}
function parseTsunamiHistory(xml) {
  if (!xml || typeof xml !== "string") return [];
  const alertRecords = xml.match(/<(?:[\w.-]+:)?alert\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?alert\s*>/gi) || [];
  const itemRecords = xml.match(/<(?:[\w.-]+:)?(?:entry|item)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:entry|item)\s*>/gi) || [];
  const parents = alertRecords.length ? alertRecords : (itemRecords.length ? itemRecords : [xml]);
  const output = [];
  for (const parent of parents.slice(0, 40)) {
    const infos = parent.match(/<(?:[\w.-]+:)?info\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?info\s*>/gi) || [];
    for (const info of (infos.length ? infos : [parent]).slice(0, 3)) {
      const read = (...tags) => {
        for (const tag of tags) {
          const v = xmlValue(info, tag) || (info !== parent ? xmlValue(parent, tag) : "");
          if (v) return v;
        }
        return "";
      };
      const subject = read("subject", "headline") || "WARNING TSUNAMI";
      const headline = read("headline");
      const description = read("description", "summary");
      const eventId = read("eventid", "EventID", "identifier", "id") || [read("date", "tanggal"), read("time", "jam"), headline, subject].join("|");
      const pdMatch = (subject + " " + headline + " " + description).match(/PD[-\s]?([\d.]+)/i);
      const sent = read("timesent", "sent", "updated", "published");
      const origin = read("EventOriginTime", "originTime", "datetime", "effective");
      const eventTime = eventTimeFromCap(read("date", "tanggal"), read("time", "jam"), origin);
      const capStatus = read("status").toLowerCase();
      const msgType = read("msgType", "messageType", "msgtype").toLowerCase();
      const ended = /berakhir|all[\s-]?clear|dicabut|cancel|cancelled|canceled/i.test(subject + " " + headline + " " + description) ||
        capStatus === "cancel" || msgType === "cancel";
      const potential = read("potential") || subject || headline;
      const instruction = read("instruction") || "Ikuti arahan resmi BMKG/InaTEWS.";
      const record = {
        key: "tsun-" + eventId + "-" + (pdMatch ? pdMatch[1] : "0"),
        eventid: eventId,
        magnitude: num(read("magnitude", "EventMagnitude")) || 0,
        lat: null,
        lon: null,
        depth: "—",
        place: read("area", "EventLocationName", "ShortLocationName", "areaDesc") || "Indonesia",
        time: eventTime,
        timesent: sent,
        expires: read("expires", "expiry"),
        subject,
        headline,
        description,
        instruction,
        potential,
        pd: pdMatch ? pdMatch[1] : null,
        ended,
        capStatus: capStatus || null,
        capMsgType: msgType || null,
        source: "InaTEWS",
        isTsunamiWarning: true,
        official: true
      };
      if (record.time || record.timesent || record.subject || record.headline) output.push(record);
    }
  }
  const unique = new Map();
  for (const record of output) {
    if (!unique.has(record.key)) unique.set(record.key, record);
  }
  return [...unique.values()]
    .sort((a, b) => (Date.parse(b.timesent || b.time || "") || 0) - (Date.parse(a.timesent || a.time || "") || 0))
    .slice(0, 30);
}
function timestampMs(value) {
  let raw = text(value);
  if (!raw) return NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)) {
    raw = raw.replace(" ", "T") + "+07:00";
  }
  return Date.parse(raw);
}
function priority(item) {
  const source = String(item.source || "").toUpperCase();
  if (source === "BMKG" && item.official) return 4;
  if (source.includes("INATEWS") && item.wrsRealtime) return 3;
  if (source.includes("INATEWS")) return 2;
  if (source === "USGS") return 1;
  return 0;
}
function distanceKm(a, b) {
  const radians = n => n * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function sameEvent(a, b) {
  if (a.key && a.key === b.key) return true;
  const at = timestampMs(a.time), bt = timestampMs(b.time);
  if (!Number.isFinite(at) || !Number.isFinite(bt) ||
      !validCoordinates(a.lat, a.lon) || !validCoordinates(b.lat, b.lon)) return false;
  return Math.abs(at - bt) <= 5 * 60 * 1000 &&
    distanceKm(a, b) <= 35 &&
    Math.abs(Number(a.magnitude) - Number(b.magnitude)) <= 0.5;
}
function mergeEvents(events) {
  const sorted = events.filter(Boolean).sort((a, b) =>
    priority(b) - priority(a) ||
    (timestampMs(b.time) || 0) - (timestampMs(a.time) || 0));
  const output = [];
  for (const event of sorted) {
    if (output.some(previous => sameEvent(previous, event))) continue;
    output.push(event);
  }
  return output.sort((a, b) => (timestampMs(b.time) || 0) - (timestampMs(a.time) || 0)).slice(0, 800);
}
function buildRegionalUsgsUrl() {
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
export async function onRequestGet() {
  const errors = [];
  const jobs = await Promise.allSettled([
    ...BMKG_URLS.map((url, index) => fetchJson(url, "BMKG feed " + (index + 1), 4000, 20)),
    fetchJson(WRS_LIVE_URL, "InaTEWS realtime", 3500, 0, true),
    fetchUsgsGlobal(),
    fetchJson(buildRegionalUsgsUrl(), "USGS Indonesia M2+", 4500, 30),
    fetchTsunamiXml()
  ]);
  const bmkgResults = jobs.slice(0, 3);
  const bmkgEvents = [];
  let bmkgOk = 0;
  bmkgResults.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      errors.push("BMKG feed " + (index + 1) + ": " + String(result.reason?.message || result.reason).slice(0, 120));
      return;
    }
    bmkgOk++;
    const raw = result.value?.Infogempa?.gempa;
    (Array.isArray(raw) ? raw : raw ? [raw] : []).forEach(item => {
      const event = mapBmkg(item);
      if (event) bmkgEvents.push(event);
    });
  });
  const live = jobs[3];
  let wrsEvents = [];
  if (live.status === "fulfilled") {
    wrsEvents = featureList(live.value).map(mapWrsFeature).filter(Boolean)
      .map(event => ({ ...event, source: "InaTEWS WRS", status: "M", wrsRealtime: true }));
  } else {
    errors.push("InaTEWS realtime: " + String(live.reason?.message || live.reason).slice(0, 120));
  }
  const global = jobs[4];
  const globalEvents = global.status === "fulfilled"
    ? featureList(global.value).map(item => mapUsgsFeature(item, 5)).filter(Boolean)
    : [];
  if (global.status !== "fulfilled") errors.push("USGS global: " + String(global.reason?.message || global.reason).slice(0, 120));
  const regional = jobs[5];
  const regionalEvents = regional.status === "fulfilled"
    ? featureList(regional.value).map(item => mapUsgsFeature(item, 2)).filter(Boolean)
    : [];
  if (regional.status !== "fulfilled") errors.push("USGS Indonesia: " + String(regional.reason?.message || regional.reason).slice(0, 120));
  const tsunamiResult = jobs[6];
  let tsunamiHistory = [];
  if (tsunamiResult.status === "fulfilled") {
    try {
      tsunamiHistory = parseTsunamiHistory(tsunamiResult.value);
    } catch (error) {
      errors.push("InaTEWS tsunami parse: " + String(error?.message || error).slice(0, 120));
    }
  } else {
    errors.push("InaTEWS tsunami: " + String(tsunamiResult.reason?.message || tsunamiResult.reason).slice(0, 120));
  }
  const recent = mergeEvents([...bmkgEvents, ...wrsEvents, ...globalEvents, ...regionalEvents]);
  const official = [...bmkgEvents].sort((a, b) =>
    (timestampMs(b.time) || 0) - (timestampMs(a.time) || 0))[0] ||
    [...wrsEvents].sort((a, b) => (timestampMs(b.time) || 0) - (timestampMs(a.time) || 0))[0] ||
    null;
  const successCount = bmkgOk + (live.status === "fulfilled" ? 1 : 0) +
    (global.status === "fulfilled" ? 1 : 0) + (regional.status === "fulfilled" ? 1 : 0) +
    (tsunamiResult.status === "fulfilled" ? 1 : 0);
  if (successCount === 0) {
    return new Response(JSON.stringify({
      ok: false,
      error: "Feed push gempa sementara tidak tersedia",
      fetchedAt: new Date().toISOString(),
      sources: { bmkg: bmkgOk, errors }
    }), { status: 503, headers: responseHeaders });
  }
  return new Response(JSON.stringify({
    ok: true,
    fetchedAt: new Date().toISOString(),
    refreshSeconds: 30,
    latest: official || recent[0] || null,
    realtime: recent.find(event => event.wrsRealtime) || null,
    realtimeEvents: wrsEvents,
    official,
    recent,
    count: recent.length,
    tsunamiHistory,
    sources: {
      wrs: { ok: live.status === "fulfilled", eventCount: wrsEvents.length },
      public: bmkgOk,
      usgsGlobal: global.status === "fulfilled" ? globalEvents.length : 0,
      usgsIndonesia: regional.status === "fulfilled" ? regionalEvents.length : 0,
      tsunami: tsunamiHistory.length,
      errors
    }
  }), { status: 200, headers: responseHeaders });
}
