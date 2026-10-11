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
  return {key:"ql|"+String(p.id||p.time+"|"+lat+"|"+lon),eventid:String(p.id||p.time+"|"+lat+"|"+lon),magnitude:mag,lat,lon,place:String(p.place||"Indonesia"),depth:String(c[2]??p.depth??"—"),time:p.time?new Date(p.time).toISOString():"",potential:"—",felt:"",source:"InaTEWS",status:"M",wrsRealtime:true};
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
    .slice(0, 12);
  await Promise.all(candidates.map(async q => {
    try {
      const detail = await getJson(q.detailUrl);
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
      ended: /telah\s*berakhir|berakhir|all[\s-]?clear|dinyatakan\s*telah\s*berakhir/i.test(headline + " " + description + " " + subject),
      source: "InaTEWS", isTsunamiWarning: true, official: true
    });
  }
  return list.sort((a,b) => new Date(b.time || 0) - new Date(a.time || 0));
}
async function getText(url) {
  const res = await fetch(url, {
    headers: { accept: "application/xml,text/xml,*/*", referer: "https://inatews.bmkg.go.id/web/tsunami" },
    cf: { cacheTtl: 30, cacheEverything: true }
  });
  if (!res.ok) throw new Error("upstream HTTP " + res.status);
  return res.text();
}

async function getJson(url) {
  const res=await fetch(url,{headers:{accept:"application/json"},cf:{cacheTtl:10,cacheEverything:true}});
  if(!res.ok) throw new Error("upstream HTTP "+res.status);
  return res.json();
}
export async function onRequestGet() {
  const errors=[];
  const results=await Promise.allSettled([
    ...BMKG_URLS.map(url=>getJson(url)),
    getJson(GCS+"/gempaQL.json"),
    getJson(USGS),
    getJson(usgsIndonesiaUrl()),
    getText("https://cdn.bmkg.go.id/last30tsunamievent.xml")
  ]);
  const list=[];
  const qlEvents=[];
  results.slice(0,3).forEach((r,i)=>{
    if(r.status!=="fulfilled"){errors.push("BMKG "+i);return;}
    const g=r.value?.Infogempa?.gempa;
    (Array.isArray(g)?g:g?[g]:[]).forEach(x=>{const q=mapPublic(x);if(q)list.push(q);});
  });
  const ql=results[3];
  if(ql.status==="fulfilled") (ql.value.features||[]).forEach(f=>{const q=mapQL(f);if(q){qlEvents.push(q);list.push(q);}});
  else errors.push("InaTEWS QL");
  const usgs=results[4];
  if(usgs.status==="fulfilled") (usgs.value.features||[]).forEach(f=>{const q=mapUSGS(f, 5);if(q)list.push(q);});
  else errors.push("USGS global");
  const usgsIndonesia=results[5];
  if(usgsIndonesia.status==="fulfilled") (usgsIndonesia.value.features||[]).forEach(f=>{const q=mapUSGS(f, 2);if(q)list.push(q);});
  else errors.push("USGS Indonesia");
  await attachUSGSShakemaps(list);
  // Jika event BMKG tidak menyediakan ShakeMap, gunakan peta USGS untuk event
  // yang cocok secara waktu, magnitudo, dan lokasi; jangan mengubah sumber event.
  for (const officialEvent of list.filter(q => q.official && !q.shakemap && Number.isFinite(q.lat) && Number.isFinite(q.lon))) {
    const match = list.find(q => q.source === "USGS" && q.shakemap &&
      Number.isFinite(new Date(q.time).getTime()) && Number.isFinite(new Date(officialEvent.time).getTime()) &&
      Math.abs(new Date(q.time).getTime() - new Date(officialEvent.time).getTime()) <= 5 * 60 * 1000 &&
      Math.abs(q.magnitude - officialEvent.magnitude) <= 0.6 &&
      Math.abs(q.lat - officialEvent.lat) <= 0.8 && Math.abs(q.lon - officialEvent.lon) <= 0.8);
    if (match) {
      officialEvent.shakemap = match.shakemap;
      officialEvent.shakemapSource = "USGS ShakeMap (fallback)";
    }
  }
  const tsunami=results[6];
  const tsunamiHistory=tsunami.status==="fulfilled" ? parseTsunamiCapXml(tsunami.value) : [];
  if(tsunami.status!=="fulfilled") errors.push("InaTEWS tsunami");
  const eventPriority = q => q.source === "BMKG" && q.official ? 3 : q.source === "InaTEWS" ? 2 : q.source === "USGS" ? 1 : 0;
  const validTime = q => {
    const t = new Date(q.time || 0).getTime();
    return Number.isFinite(t) && t > 0 ? t : NaN;
  };
  const distanceKm = (a, b) => {
    const rad = n => n * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
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
  const unique = [];
  list.sort((a,b)=>validTime(b)-validTime(a)).forEach(q => {
    const matches = unique.map((item, index) => ({item, index})).filter(({item}) => sameEvent(item, q));
    if (!matches.length) {
      unique.push(q);
      return;
    }
    // Keep one event per real earthquake. BMKG's official record wins in Indonesia;
    // InaTEWS is next; USGS is retained only when no matching higher-priority record exists.
    const best = matches.reduce((winner, candidate) =>
      eventPriority(candidate.item) > eventPriority(winner.item) ? candidate : winner, matches[0]);
    if (eventPriority(q) > eventPriority(best.item)) {
      const indexes = matches.map(match => match.index).sort((a,b)=>b-a);
      indexes.forEach(index => unique.splice(index, 1));
      unique.push(q);
    }
  });
  const recent=unique.sort((a,b)=>validTime(b)-validTime(a)).slice(0,800);
  const inIndonesia = q => q.lat >= -11 && q.lat <= 6.5 && q.lon >= 94 && q.lon <= 141.5;
  const official=recent.find(q=>q.source === "BMKG" && q.official && inIndonesia(q)) ||
    recent.find(q=>q.official) || null;
  // Keep the WRS/InaTEWS realtime stream separate from the merged catalog.
  // The catalog deduplicates records and prefers BMKG; it must not replace the WRS event.
  const realtimeEvents=qlEvents
    .filter(q=>Number.isFinite(validTime(q)) && inIndonesia(q))
    .sort((a,b)=>validTime(b)-validTime(a));
  const realtime=realtimeEvents[0] || null;
  return new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:15,latest:realtime||official||recent[0]||null,realtime,realtimeEvents,official,recent,count:recent.length,tsunamiHistory,sources:{public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:ql.status==="fulfilled"?(ql.value.features||[]).length:0,usgs:(usgs.status==="fulfilled"?(usgs.value.features||[]).length:0)+(usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0),usgsGlobal:usgs.status==="fulfilled"?(usgs.value.features||[]).length:0,usgsIndonesia:usgsIndonesia.status==="fulfilled"?(usgsIndonesia.value.features||[]).length:0,tsunami:tsunamiHistory.length,client:false,errors}}),{status:200,headers});
}
