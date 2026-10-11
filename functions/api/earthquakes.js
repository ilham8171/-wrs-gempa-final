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
  return /LS|S\b/i.test(s) ? -Math.abs(n) : Math.abs(n);
}
function parseLon(v) {
  if (v == null) return NaN;
  const s = String(v).trim(), n = parseFloat(s.replace(/,/g, "."));
  if (!Number.isFinite(n)) return NaN;
  return /BB|W\b/i.test(s) ? -Math.abs(n) : Math.abs(n);
}
function mapPublic(raw) {
  if (!raw) return null;
  const coords = String(raw.Coordinates ?? raw.coordinates ?? "").split(",");
  const lat = coords.length > 1 ? num(coords[0]) : parseLat(raw.Lintang);
  const lon = coords.length > 1 ? num(coords[1]) : parseLon(raw.Bujur);
  const mag = num(raw.Magnitude ?? raw.magnitude);
  if (!Number.isFinite(mag)) return null;
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
async function getJson(url) {
  const res=await fetch(url,{headers:{accept:"application/json"},cf:{cacheTtl:0}});
  if(!res.ok) throw new Error("upstream HTTP "+res.status);
  return res.json();
}
export async function onRequestGet() {
  const errors=[];
  const results=await Promise.allSettled([
    ...BMKG_URLS.map(url=>getJson(url)),
    getJson(GCS+"/gempaQL.json"),
    getJson(USGS)
  ]);
  const list=[];
  results.slice(0,3).forEach((r,i)=>{
    if(r.status!=="fulfilled"){errors.push("BMKG "+i);return;}
    const g=r.value?.Infogempa?.gempa;
    (Array.isArray(g)?g:g?[g]:[]).forEach(x=>{const q=mapPublic(x);if(q)list.push(q);});
  });
  const ql=results[3];
  if(ql.status==="fulfilled") (ql.value.features||[]).forEach(f=>{const q=mapQL(f);if(q)list.push(q);});
  const usgs=results[4];
  if(usgs.status==="fulfilled") (usgs.value.features||[]).forEach(f=>{const q=mapUSGS(f);if(q)list.push(q);});
  const byKey=new Map(), signatures=new Set();
  list.sort((a,b)=>new Date(b.time||0)-new Date(a.time||0)).forEach(q=>{
    const sig=[q.magnitude.toFixed(1),(q.place||"").slice(0,30),String(q.time).slice(0,16)].join("|");
    if(!byKey.has(q.key)&&!signatures.has(sig)){byKey.set(q.key,q);signatures.add(sig);}
  });
  const recent=[...byKey.values()].sort((a,b)=>new Date(b.time||0)-new Date(a.time||0)).slice(0,800);
  const official=recent.find(q=>q.official)||null;
  return new Response(JSON.stringify({ok:true,fetchedAt:new Date().toISOString(),refreshSeconds:10,latest:recent[0]||null,official,recent,count:recent.length,sources:{public:results.slice(0,3).filter(r=>r.status==="fulfilled").length,inaQL:ql.status==="fulfilled"?(ql.value.features||[]).length:0,usgs:usgs.status==="fulfilled"?(usgs.value.features||[]).length:0,client:false,errors}}),{status:200,headers});
}
