const BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const GCS = "https://bmkg-content-inatews.storage.googleapis.com";
const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
function usgsIndonesiaUrl() {
  const starttime = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19);
  return "https://earthquake.usgs.gov/fdsnws/event/1/query?" + new URLSearchParams({
    format: "geojson",
    starttime,
    minlatitude: "-11",
    maxlatitude: "6.5",
    minlongitude: "94",
    maxlongitude: "141.5",
    minmagnitude: "2",
    orderby: "time",
    limit: "150"
  }).toString();
}
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
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
  return {key:"ql|"+String(p.id||p.time+"|"+lat+"|"+lon),eventid:String(p.id||p.time+"|"+lat+"|"+lon),magnitude:mag,lat,lon,place,depth,time:p.time?new Date(p.time).toISOString():"",potential:"—",felt:"",source:"InaTEWS",status:"M",wrsRealtime:true};
}
function mapUSGS(f, minimumMagnitude = 5) {
  const p=f?.properties||{}, c=f?.geometry?.coordinates||[], mag=num(p.mag), lon=num(c[0]), lat=num(c[1]), flag=Number(p.tsunami)===1;
  // Global feed is strictly M5+; tsunami flag alone must not bypass the threshold.
  if (!Number.isFinite(mag) || mag < minimumMagnitude) return null;
  if (!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  return {key:"usgs|"+String(f.id||p.code||p.time),eventid:String(f.id||""),magnitude:Number.isFinite(mag)?Math.round(mag*10)/10:0,lat,lon,place:String(p.place||"Gempa global"),depth:String(c[2]??"—"),time:p.time?new Date(p.time).toISOString():"",potential:flag?"USGS menandai event terkait tsunami — periksa buletin resmi":"—",felt:"",source:"USGS",status:"USGS",official:false,usgsTsunamiFlag:flag,eventUrl:String(p.url||""),detailUrl:String(p.detail||""),shakemap:null};
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
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
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
function parseTsunamiCapXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const infos = xml.match(/<info\b[^>]*>[\s\S]*?<\/info>/gi) || [];
  const list = [];
  for (const block of infos) {
    const subject = textBetween(block, "subject") || textBetween(block, "headline");
    const headline = textBetween(block, "headline");
    const description = textBetween(block, "description");
    const date = textBetween(block, "date");
    const time = textBetween(block, "time");
    const coordText = textBetween(block, "coordinates");
    const coords = coordText ? coordText.split(",").map(v => num(v.trim())) : [];
    const lon = coords.length > 1 ? coords[0] : parseLon(textBetween(block, "longitude"));
    const lat = coords.length > 1 ? coords[1] : parseLat(textBetween(block, "latitude"));
    const mag = num(textBetween(block, "magnitude"));
    const depthRaw = textBetween(block, "depth");
    const depth = depthRaw.match(/[0-9]+(?:[.,][0-9]+)?/)?.[0] || "—";
    const area = textBetween(block, "area") || "Indonesia";
    const eventid = textBetween(block, "eventid") || [date, time, mag, lat, lon].join("|");
    const pdMatch = (subject + " " + headline).match(/PD[-\s]?([\d.]+)/i);
    const pd = pdMatch ? pdMatch[1] : "";
    const potential = textBetween(block, "potential") || subject || headline;
    const instruction = textBetween(block, "instruction");
    const instruction1 = textBetween(block, "instruction1");
    const instruction2 = textBetween(block, "instruction2");
    const instruction3 = textBetween(block, "instruction3");
    const timesent = textBetween(block, "timesent");
    const shakemap = textBetween(block, "shakemap");
    const wzmap = textBetween(block, "wzmap");
    const ttmap = textBetween(block, "ttmap");
    const sshmap = textBetween(block, "sshmap");
    // Only accept geographic bounds explicitly supplied by the source bulletin.
    // Never derive raster bounds from the earthquake epicenter or image dimensions.
    const explicitBound = (...tags) => {
      for (const tag of tags) {
        const value = textBetween(block, tag);
        if (value) {
          const parsed = num(value);
          if (Number.isFinite(parsed)) return parsed;
        }
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
      sshBoundsRaw.minLat < sshBoundsRaw.maxLat &&
      sshBoundsRaw.minLon < sshBoundsRaw.maxLon &&
      sshBoundsRaw.minLat >= -90 && sshBoundsRaw.maxLat <= 90 &&
      sshBoundsRaw.minLon >= -180 && sshBoundsRaw.maxLon <= 180
      ? sshBoundsRaw : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    list.push({
      key: "tsun-" + eventid + "-" + (pd || list.length),
      eventid, magnitude: Number.isFinite(mag) ? mag : 0, lat, lon, depth,
      place: area, time: capEventTime(date, time), date, timeLocal: time,
      potential: potential || "Riwayat peringatan dini tsunami InaTEWS",
      subject: subject || ("WARNING TSUNAMI PD-" + (pd || "?")),
      pd: pd || null, headline, description, instruction, instruction1, instruction2, instruction3, timesent,
      shakemap: mapCapAsset(shakemap) || null,
      wzmap: mapCapAsset(wzmap), ttmap: mapCapAsset(ttmap), sshmap: mapCapAsset(sshmap),
      ...(sshBounds ? { sshBounds } : {}),
      ended: /telah\s*berakhir|berakhir|all[\s-]?clear|dinyatakan\s*telah\s*berakhir/i.test(headline + " " + description + " " + subject),
      source: "InaTEWS", isTsunamiWarning: true, official: true
    });
  }
  return list.sort((a,b) => new Date(b.time || 0) - new Date(a.time || 0));
}
async function getText(url, timeoutMs = 4000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/xml,text/xml,*/*", referer: "https://inatews.bmkg.go.id/web/tsunami" },
    cf: { cacheTtl: 30, cacheEverything: true }
  });
  if (!res.ok) throw new Error("upstream HTTP " + res.status);
  return res.text();
}

async function getJson(url, live = false, timeoutMs = 4000) {
  const requestUrl = live ? url + (url.includes("?") ? "&" : "?") + "_wrs_ts=" + Date.now() : url;
  const res = await fetch(requestUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", ...(live ? { "cache-control": "no-cache" } : {}) },
    ...(live ? { cf: { cacheTtl: 0, cacheEverything: false } } : { cf: { cacheTtl: 10, cacheEverything: true } })
  });
  if (!res.ok) throw new Error("upstream HTTP " + res.status);
  return res.json();
}
function qlFeatures(value) {
  if (Array.isArray(value?.features)) return value.features;
  if (value?.type === "Feature") return [value];
  if (Array.isArray(value)) return value;
  return [];
}
export async function onRequestGet({ request, waitUntil } = {}) {
  // Share a single upstream refresh across clients in the same Cloudflare edge location.
  // The browser polls every 4s; this 7s freshness window lets the next poll reuse the
  // same response, while a later poll refreshes the upstream feeds roughly every 8s.
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
          if (ageMs <= 7000) {
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
  const results=await Promise.allSettled([
    ...BMKG_URLS.map(url=>getJson(url)),
    getJson(GCS+"/lastQL.json", true, 3500),
    getJson(GCS+"/gempaQL.json"),
    // USGS can respond slower than the local BMKG feeds; allow a little more
    // time before marking the optional backup source unavailable.
    getJson(USGS, false, 6500),
    getJson(usgsIndonesiaUrl(), false, 6500),
    getText("https://cdn.bmkg.go.id/last30tsunamievent.xml")
  ]);
  const list=[];
  const qlEvents=[];
  const bmkgFeedNames = ["BMKG autogempa.json", "BMKG gempaterkini.json", "BMKG gempadirasakan.json"];
  results.slice(0,3).forEach((r,i)=>{
    if(r.status!=="fulfilled"){errors.push(bmkgFeedNames[i] + " gagal diakses");return;}
    const g=r.value?.Infogempa?.gempa;
    (Array.isArray(g)?g:g?[g]:[]).forEach(x=>{const q=mapPublic(x);if(q)list.push(q);});
  });
  // lastQL.json adalah feed realtime terbaru; gempaQL.json adalah katalog/riwayat.
  const ql=results[3];
  const historyQL=results[4];
  const liveQL = ql.status === "fulfilled" ? qlFeatures(ql.value).map(mapQL).filter(Boolean) : [];
  if (ql.status !== "fulfilled") errors.push("InaTEWS lastQL");
  // Bound the historical catalogue before merging/deduplication. A large upstream\n  // archive must not exhaust the Pages Function CPU/memory budget and turn the\n  // entire live endpoint into an HTTP 503. Live lastQL remains untruncated.\n  const historyEvents = historyQL.status === "fulfilled"\n    ? qlFeatures(historyQL.value).map(mapQL).filter(Boolean)\n        .sort((a, b) => validEventTime(b.time) - validEventTime(a.time)).slice(0, 600)\n    : [];
  if (historyQL.status !== "fulfilled") errors.push("InaTEWS gempaQL");
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
  const usgs=results[5];
  const usgsGlobalFeatures = usgs.status==="fulfilled" && Array.isArray(usgs.value?.features) ? usgs.value.features : [];
  if(usgs.status==="fulfilled") {
    usgsGlobalFeatures.forEach(f=>{const q=mapUSGS(f, 5);if(q)list.push(q);});
  } else {
    errors.push("USGS global: " + String(usgs.reason?.message || "permintaan gagal").slice(0,120));
  }
  const usgsIndonesia=results[6];
  if(usgsIndonesia.status==="fulfilled") {
    (usgsIndonesia.value.features||[]).forEach(f=>{const q=mapUSGS(f, 2);if(q)list.push(q);});
  } else {
    errors.push("USGS Indonesia: " + String(usgsIndonesia.reason?.message || "permintaan gagal").slice(0,120));
    // Resilience fallback: if the regional FDSN query times out, recover Indonesian
    // M2+ events from the already-fetched global weekly GeoJSON feed. This is a
    // partial fallback (the global feed may omit smaller events), but it keeps
    // useful USGS backup coverage without blocking the main BMKG/WRS response.
    const inIndonesia = q => q.lat >= -11 && q.lat <= 6.5 && q.lon >= 94 && q.lon <= 141.5;
    usgsGlobalFeatures.forEach(f => {
      const q = mapUSGS(f, 2);
      if (q && inIndonesia(q)) {
        q.usgsRegionalFallback = true;
        list.push(q);
      }
    });
  }
  // Jangan menunggu permintaan detail ShakeMap USGS untuk mengirim katalog.
  // Peta USGS dimuat on-demand ketika pengguna membuka detail event; ini menjaga
  // polling operasional tetap cepat dan tidak membebani feed pada setiap refresh.
  const tsunami=results[7];
  const tsunamiHistory=tsunami.status==="fulfilled" ? parseTsunamiCapXml(tsunami.value) : [];
  if(tsunami.status!=="fulfilled") errors.push("InaTEWS tsunami");
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
  const anyQuakeSourceAvailable = results.slice(0, 7).some(r => r.status === "fulfilled");
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
  const response = new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:8,latest:realtime||official||recent[0]||null,realtime,realtimeEvents,official,recent,count:recent.length,tsunamiHistory,sources:{wrs:{ok:ql.status==="fulfilled",eventCount:liveEvents.length,checkedAt:new Date().toISOString(),error:ql.status==="rejected"?String(ql.reason?.message||"Feed InaTEWS lastQL gagal diakses"):null},wrsHistory:{ok:historyQL.status==="fulfilled",eventCount:historyEvents.length,error:historyQL.status==="rejected"?String(historyQL.reason?.message||"Feed InaTEWS gempaQL gagal diakses"):null},public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:historyEvents.length,usgs:(usgs.status==="fulfilled"?(usgs.value.features||[]).length:0)+(usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0),usgsGlobal:usgs.status==="fulfilled"?(usgs.value.features||[]).length:0,usgsIndonesia:usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0,tsunami:tsunamiHistory.length,client:false,errors}}),{status:200,headers});
  if (edgeCache && edgeCacheKey) {
    try {
      const cacheHeaders = new Headers(response.headers);
      // Retain the last known-good payload for recovery, but the handler above
      // only serves it as fresh for 4 seconds; older copies are fallback-only.
      cacheHeaders.set("cache-control", "public, max-age=900");
      cacheHeaders.set("x-wrs-cache", "MISS");
      const cacheResponse = new Response(response.clone().body, { status: response.status, headers: cacheHeaders });
      if (typeof waitUntil === "function") waitUntil(edgeCache.put(edgeCacheKey, cacheResponse));
      else await edgeCache.put(edgeCacheKey, cacheResponse);
    } catch (_) { /* Never fail the live API solely because edge caching failed. */ }
  }
  return response;
}
