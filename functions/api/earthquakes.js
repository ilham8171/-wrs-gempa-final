const BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const GCS = "https://bmkg-content-inatews.storage.googleapis.com";
const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
function usgsIndonesiaUrl() {
  // This regional request is a supplemental fallback, so keep its payload
  // bounded to the latest 72 hours; BMKG/InaTEWS remains the primary catalogue.
  const starttime = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 19);
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
  // Global feed normally stays M5+, but preserve events explicitly flagged
  // by USGS as tsunami-related even when their reported magnitude is lower.
  // This metadata is not confirmation of an active tsunami warning.
  if (!Number.isFinite(mag) || (mag < minimumMagnitude && !flag)) return null;
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

function parseNoaaTsunamiAtom(xml, center) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const entries = xml.match(/<(?:[\w.-]+:)?entry\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?entry\s*>/gi) || [];
  const readTag = (block, tag) => textBetween(block, tag);
  const readLink = block => {
    const m = block.match(/<(?:[\w.-]+:)?link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
    return m ? m[1] : "";
  };
  const centerName = center === "PTWC" ? "Pacific Tsunami Warning Center" : "National Tsunami Warning Center";
  const out = [];
  for (const entry of entries) {
    const identifier = readTag(entry, "id") || readLink(entry);
    const title = readTag(entry, "title");
    const summary = readTag(entry, "summary") || readTag(entry, "content");
    const published = readTag(entry, "published") || readTag(entry, "updated");
    const cleanText = (title + " " + summary).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
    if (!/tsunami/i.test(cleanText)) continue;
    const explicitlyNoThreat = /no tsunami (warning|advisory|watch|threat)|there is no tsunami warning|no tsunami threat/i.test(cleanText);
    const cancelled = /cancelled|canceled|all clear|no longer in effect/i.test(cleanText);
    const active = !explicitlyNoThreat && !cancelled &&
      /\b(warning|advisory|watch|threat)\b/i.test(cleanText) &&
      !/information statement|earthquake information/i.test(title);
    const timeMs = Date.parse(published);
    out.push({
      key: "noaa-tsunami-atom|" + center + "|" + (identifier || published || title),
      eventid: identifier || published || title,
      source: "tsunami.gov / NOAA " + center + " (Atom fallback)",
      sourceUrl: readLink(entry) || "https://www.tsunami.gov/",
      center: centerName,
      subject: title || "Pesan tsunami NOAA",
      headline: title || "Pesan tsunami NOAA",
      description: summary,
      instruction: "",
      areas: [],
      severity: "",
      urgency: "",
      status: "actual",
      messageType: cancelled ? "Cancel" : "Update",
      sent: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : published,
      expires: "",
      active,
      isTsunamiWarning: active,
      official: true,
      potential: active ? title : (title || "Informasi tsunami NOAA"),
      time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : "",
      ended: !active,
      feedFormat: "Atom",
      coverageNote: "Feed Atom resmi NOAA dipakai sebagai cadangan; untuk Indonesia tetap utamakan peringatan BMKG/InaTEWS."
    });
  }
  return out.sort((a,b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)).slice(0, 40);
}

function parseNoaaTsunamiCap(xml, center) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const alerts = xml.match(/<(?:[\w.-]+:)?alert\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?alert\s*>/gi) || [];
  const out = [];
  for (const alert of alerts) {
    const identifier = textBetween(alert, "identifier");
    const status = textBetween(alert, "status").toLowerCase();
    const messageType = textBetween(alert, "msgType").toLowerCase();
    const sent = textBetween(alert, "sent");
    const infos = alert.match(/<(?:[\w.-]+:)?info\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?info\s*>/gi) || [];
    for (const info of infos) {
      const event = textBetween(info, "event");
      const headline = textBetween(info, "headline");
      const description = textBetween(info, "description");
      const instruction = textBetween(info, "instruction");
      const areaDescs = (info.match(/<(?:[\w.-]+:)?area\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?area\s*>/gi) || [])
        .map(area => textBetween(area, "areaDesc")).filter(Boolean);
      const severity = textBetween(info, "severity");
      const urgency = textBetween(info, "urgency");
      const expires = textBetween(info, "expires");
      const text = [event, headline, description].join(" ");
      if (!/tsunami/i.test(text)) continue;
      const active = status === "actual" && !["cancel", "ack"].includes(messageType) &&
        (!expires || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) > Date.now()) &&
        !/no tsunami (warning|advisory|watch|threat)|no tsunami threat/i.test(text);
      const centerName = center === "PTWC" ? "Pacific Tsunami Warning Center" : "National Tsunami Warning Center";
      out.push({
        key: "noaa-tsunami|" + center + "|" + (identifier || sent || headline),
        eventid: identifier || sent || headline,
        source: "tsunami.gov / NOAA " + center,
        sourceUrl: "https://www.tsunami.gov/",
        center: centerName,
        subject: event || headline || "Pesan tsunami NOAA",
        headline: headline || event,
        description,
        instruction,
        areas: areaDescs,
        severity,
        urgency,
        status,
        messageType,
        sent,
        expires,
        active,
        isTsunamiWarning: active,
        official: true,
        potential: active ? (headline || event || "Pesan tsunami aktif dari NOAA") : (headline || event || "Pesan informasi tsunami NOAA"),
        time: sent && Number.isFinite(Date.parse(sent)) ? new Date(sent).toISOString() : "",
        ended: !active,
        coverageNote: "Cakupan tsunami.gov terutama wilayah layanan pusat tsunami AS dan pesan ancaman internasional; bukan pengganti peringatan resmi BMKG/InaTEWS untuk Indonesia."
      });
    }
  }
  return out.sort((a,b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)).slice(0, 40);
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
    const value = await getJson(jsonUrl, false, 3500);
    const gempa = value?.Infogempa?.gempa;
    if (gempa && (Array.isArray(gempa) || typeof gempa === "object")) return value;
    jsonError = new Error("respons JSON tidak memiliki Infogempa.gempa");
  } catch (error) {
    jsonError = error;
  }
  const xmlUrl = jsonUrl.replace(/\.json(?:\?.*)?$/i, ".xml");
  try {
    const xml = await getText(xmlUrl, 3500);
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
async function handleEarthquakesRequest({ request, waitUntil } = {}) {
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
    ...BMKG_URLS.map(url=>getBmkgFeed(url)),
    getJson(GCS+"/lastQL.json", true, 3500),
    getJson(GCS+"/gempaQL.json"),
    // USGS can respond slower than the local BMKG feeds; allow a little more
    // time before marking the optional backup source unavailable.
    getJson(USGS, false, 6500),
    getJson(usgsIndonesiaUrl(), false, 6500),
    getText("https://cdn.bmkg.go.id/last30tsunamievent.xml"),
    getText("https://www.tsunami.gov/events/xml/PHEBCAP.xml", 4500),
    getText("https://www.tsunami.gov/events/xml/PAAQCAP.xml", 4500),
    getText("https://www.tsunami.gov/events/xml/PHEBAtom.xml", 4500),
    getText("https://www.tsunami.gov/events/xml/PAAQAtom.xml", 4500)
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
  const historyQL=results[4];
  const liveQL = ql.status === "fulfilled" ? qlFeatures(ql.value).map(mapQL).filter(Boolean) : [];
  if (ql.status !== "fulfilled") errors.push("InaTEWS lastQL");
  // Bound historical and global raw records before mapping/sorting. Keep the live
  // lastQL stream intact, while preventing large catalogues from consuming the
  // Pages Function CPU budget and turning the endpoint into HTTP 503.
  const historyEvents = historyQL.status === "fulfilled"
    ? qlFeatures(historyQL.value).slice(0, 350).map(mapQL).filter(Boolean)
        .sort((a, b) => validEventTime(b.time) - validEventTime(a.time)).slice(0, 250)
    : [];
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
  // USGS weekly global feed can grow large. Its feed is newest-first, so cap
  // raw records before mapping to keep CPU use predictable without affecting
  // the separate, higher-priority BMKG/InaTEWS live feeds.
  const usgsGlobalFeatures = usgs.status==="fulfilled" && Array.isArray(usgs.value?.features)
    ? usgs.value.features.slice(0, 300) : [];
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
  let tsunamiHistory=tsunami.status==="fulfilled" ? parseTsunamiCapXml(tsunami.value) : [];
  if(tsunami.status!=="fulfilled") errors.push("InaTEWS tsunami");
  // tsunami.gov CAP is a supplemental official bulletin source, not a substitute
  // for BMKG/InaTEWS and not a global all-clear authority for Indonesian coasts.
  const ptwc=results[8], ntwc=results[9], ptwcAtom=results[10], ntwcAtom=results[11];
  // CAP tetap utama. Atom resmi dipakai hanya jika CAP feed pusat terkait gagal
  // atau tidak dapat diparse, sehingga status satu feed tidak mematikan feed lainnya.
  const ptwcCapMessages = ptwc.status==="fulfilled" ? parseNoaaTsunamiCap(ptwc.value, "PTWC") : [];
  const ntwcCapMessages = ntwc.status==="fulfilled" ? parseNoaaTsunamiCap(ntwc.value, "NTWC") : [];
  const ptwcAtomMessages = ptwcAtom.status==="fulfilled" ? parseNoaaTsunamiAtom(ptwcAtom.value, "PTWC") : [];
  const ntwcAtomMessages = ntwcAtom.status==="fulfilled" ? parseNoaaTsunamiAtom(ntwcAtom.value, "NTWC") : [];
  const ptwcMessages = ptwcCapMessages.length ? ptwcCapMessages : ptwcAtomMessages;
  const ntwcMessages = ntwcCapMessages.length ? ntwcCapMessages : ntwcAtomMessages;
  const tsunamiGovMessages = [...ptwcMessages, ...ntwcMessages]
    .sort((a,b) => new Date(b.time || 0) - new Date(a.time || 0)).slice(0, 40);
  const tsunamiGovActive = tsunamiGovMessages.filter(q => q.active);
  // tsunami.gov is a supplemental international feed, not a dependency of the
  // BMKG/InaTEWS earthquake API. Report its health separately so a temporary
  // NOAA outage does not mark the primary Indonesian realtime service degraded.
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
  const response = new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:8,latest:realtime||official||recent[0]||null,realtime,realtimeEvents,official,recent,count:recent.length,tsunamiHistory,tsunamiGovMessages,tsunamiGovActive,sources:{wrs:{ok:ql.status==="fulfilled",eventCount:liveEvents.length,checkedAt:new Date().toISOString(),error:ql.status==="rejected"?String(ql.reason?.message||"Feed InaTEWS lastQL gagal diakses"):null},wrsHistory:{ok:historyQL.status==="fulfilled",eventCount:historyEvents.length,error:historyQL.status==="rejected"?String(historyQL.reason?.message||"Feed InaTEWS gempaQL gagal diakses"):null},public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:historyEvents.length,usgs:(usgs.status==="fulfilled"?(usgs.value.features||[]).length:0)+(usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0),usgsGlobal:usgs.status==="fulfilled"?(usgs.value.features||[]).length:0,usgsIndonesia:usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0,tsunami:tsunamiHistory.length,tsunamiGov:{ptwcOk:ptwcMessages.length>0,ntwcOk:ntwcMessages.length>0,ptwcCapOk:ptwc.status==="fulfilled"&&ptwcCapMessages.length>0,ntwcCapOk:ntwc.status==="fulfilled"&&ntwcCapMessages.length>0,ptwcAtomOk:ptwcAtom.status==="fulfilled"&&ptwcAtomMessages.length>0,ntwcAtomOk:ntwcAtom.status==="fulfilled"&&ntwcAtomMessages.length>0,ptwcFormat:ptwcCapMessages.length?"CAP":ptwcAtomMessages.length?"Atom":"unavailable",ntwcFormat:ntwcCapMessages.length?"CAP":ntwcAtomMessages.length?"Atom":"unavailable",messageCount:tsunamiGovMessages.length,activeCount:tsunamiGovActive.length,coverage:"supplemental",errors:[...(ptwcMessages.length?[]:["tsunami.gov PTWC CAP+Atom"]),...(ntwcMessages.length?[]:["tsunami.gov NTWC CAP+Atom"])]},client:false,errors}}),{status:200,headers});
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
    // Emergency recovery: if the full catalogue handler throws and no cached
    // last-known-good response exists in this edge location, rebuild a SMALL
    // response from the primary BMKG feeds and live InaTEWS feed. Optional USGS,
    // NOAA and historical-catalogue processing must not make the core monitor
    // return HTTP 503. This is explicitly marked partial and never fabricates data.
    try {
      const emergencyResults = await Promise.allSettled([
        ...BMKG_URLS.map(url => getBmkgFeed(url)),
        getJson(GCS + "/lastQL.json", true, 2500)
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
          tsunamiGovMessages: [],
          tsunamiGovActive: [],
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
            usgs: 0,
            tsunami: 0,
            emergencyFallback: true,
            errors: ["API utama mengalami gangguan internal; memakai respons darurat BMKG/InaTEWS", "Detail gangguan: " + failure]
          }
        };
        const recoveryHeaders = new Headers(headers);
        recoveryHeaders.set("cache-control", "no-store");
        recoveryHeaders.set("x-wrs-cache", "EMERGENCY-FALLBACK");
        console.error("[WRS API] Emergency core-feed fallback served", {
          bmkgFeedsOk: bmkgOk,
          liveInaTEWSOk: liveResult.status === "fulfilled",
          eventCount: recent.length,
          cause: failure
        });
        return new Response(JSON.stringify(payload), { status: 200, headers: recoveryHeaders });
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
