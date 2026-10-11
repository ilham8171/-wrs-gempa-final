const BMKG_URLS = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json"
];
const GCS = "https://bmkg-content-inatews.storage.googleapis.com";
const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
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
  const coords = String(raw.Coordinates ?? raw.coordinates ?? "").split(",");
  const lat = coords.length > 1 ? parseLat(coords[0]) : parseLat(raw.Lintang);
  const lon = coords.length > 1 ? parseLon(coords[1]) : parseLon(raw.Bujur);
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
  return {key:"ql|"+String(p.id||p.time+"|"+lat+"|"+lon),magnitude:mag,lat,lon,place:String(p.place||"Indonesia"),depth:String(c[2]??p.depth??"—"),time:p.time?new Date(p.time).toISOString():"",potential:"—",felt:"",source:"InaTEWS",status:"M"};
}
function mapUSGS(f) {
  const p=f?.properties||{}, c=f?.geometry?.coordinates||[], mag=num(p.mag), lon=num(c[0]), lat=num(c[1]), flag=Number(p.tsunami)===1;
  if ((!Number.isFinite(mag)||mag<5)&&!flag) return null;
  if (!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  return {key:"usgs|"+String(f.id||p.code||p.time),eventid:String(f.id||""),magnitude:Number.isFinite(mag)?mag:0,lat,lon,place:String(p.place||"Gempa global"),depth:String(c[2]??"—"),time:p.time?new Date(p.time).toISOString():"",potential:flag?"USGS menandai event terkait tsunami — periksa buletin resmi":"—",felt:"",source:"USGS",status:"USGS",official:false,usgsTsunamiFlag:flag,detailUrl:String(p.url||"")};
}
function textBetween(xml, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
  const match = String(xml ?? "").match(re);
  return match ? match[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, "").trim() : "";
}
function capEventTime(date, time) {
  const d = String(date ?? "").trim();
  const t = String(time ?? "").trim().replace(/\\s*(WIB|UTC|GMT)\\s*/ig, "");
  if (!d && !t) return "";
  const isoBase = (d ? d : "").replace(/\\s+/g, "");
  let candidate = "";
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(isoBase) && /^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(t)) {
    const normalizedTime = t.length === 5 ? t + ":00" : t;
    candidate = isoBase + "T" + normalizedTime + "+07:00";
  } else {
    candidate = d + " " + t;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? candidate : parsed.toISOString();
}
function parseTsunamiCapXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) return [];
  const infos = xml.match(/<info\\b[^>]*>[\\s\\S]*?<\\/info>/gi) || [];
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
    const pdMatch = (subject + " " + headline).match(/PD[-\\s]?([\\d.]+)/i);
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
      shakemap: shakemapUrl(shakemap) || null,
      wzmap: shakemapUrl(wzmap), ttmap: shakemapUrl(ttmap), sshmap: shakemapUrl(sshmap),
      ended: /telah\\s*berakhir|berakhir|all[\\s-]?clear|dinyatakan\\s*telah\\s*berakhir/i.test(headline + " " + description + " " + subject),
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
    getText("https://cdn.bmkg.go.id/last30tsunamievent.xml")
  ]);
  const list=[];
  results.slice(0,3).forEach((r,i)=>{
    if(r.status!=="fulfilled"){errors.push("BMKG "+i);return;}
    const g=r.value?.Infogempa?.gempa;
    (Array.isArray(g)?g:g?[g]:[]).forEach(x=>{const q=mapPublic(x);if(q)list.push(q);});
  });
  const ql=results[3];
  if(ql.status==="fulfilled") (ql.value.features||[]).forEach(f=>{const q=mapQL(f);if(q)list.push(q);});
  else errors.push("InaTEWS QL");
  const usgs=results[4];
  if(usgs.status==="fulfilled") (usgs.value.features||[]).forEach(f=>{const q=mapUSGS(f);if(q)list.push(q);});
  else errors.push("USGS");
  const tsunami=results[5];
  const tsunamiHistory=tsunami.status==="fulfilled" ? parseTsunamiCapXml(tsunami.value) : [];
  if(tsunami.status!=="fulfilled") errors.push("InaTEWS tsunami");
  const byKey=new Map(), signatures=new Set();
  list.sort((a,b)=>new Date(b.time||0)-new Date(a.time||0)).forEach(q=>{
    const sig=[q.magnitude.toFixed(1),(q.place||"").slice(0,30),String(q.time).slice(0,16)].join("|");
    if(!byKey.has(q.key)&&!signatures.has(sig)){byKey.set(q.key,q);signatures.add(sig);}
  });
  const recent=[...byKey.values()].sort((a,b)=>new Date(b.time||0)-new Date(a.time||0)).slice(0,800);
  const official=recent.find(q=>q.official)||null;
  return new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:15,latest:recent[0]||null,official,recent,count:recent.length,tsunamiHistory,sources:{public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:ql.status==="fulfilled"?(ql.value.features||[]).length:0,usgs:usgs.status==="fulfilled"?(usgs.value.features||[]).length:0,tsunami:tsunamiHistory.length,client:false,errors}}),{status:200,headers});
}
