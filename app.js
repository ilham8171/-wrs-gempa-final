const API = "/api/earthquakes";
const SUBSCRIBE_API = "/api/subscribe";
const NORMAL_INTERVAL = 4000; // klien memeriksa tiap 4 dtk; edge cache membatasi fetch upstream sekitar tiap 8 dtk
const currentInterval = () => NORMAL_INTERVAL;
const SHAKEMAP_BASE = "https://bmkg-content-inatews.storage.googleapis.com/";
const $ = (s) => document.querySelector(s);

let map, markers, miniMap, miniMarker, faultLayer, radiusLayer, latestStarLayer, baseLayer, histMap, tsunamiMapLayer;
let userMarker = null;
let quakes = [];
/** Riwayat peringatan dini tsunami dari InaTEWS (last30tsunamievent.xml) */
let tsunamiHistory = [];
let alarmOn = false;
let audioCtx = null;
let firstLoad = true;
let currentOfficial = null;
let currentRealtime = null;
let realtimeEvents = [];
let operationalQuakes = [];
let wrsMode = localStorage.getItem("wrsModeV1") === "simulation" ? "simulation" : "operational";
let faultsVisible = true;
let filterState = JSON.parse(localStorage.getItem("wrsFilterV1") || "null") || { mag: 1.5, age: 168, source: "ALL", depth: "ALL" };
let lastRenderFingerprint = "";
let loadInFlight = false;
let consecutiveLoadFailures = 0;
let lastSuccessfulLoadAt = 0;
// Monotonically increasing token: responses from a previous mode/request must never
// overwrite the screen after the user switches between simulation and operation.
let loadRequestId = 0;
let refreshTimer = null;
let popupTimer = null;
let userLocation = null;
let locationAttempted = false;
const seen = new Set(JSON.parse(localStorage.getItem("wrsSeenV8") || "[]"));
/** Cache parameter terakhir per event stabil → deteksi revisi M/kedalaman/lokasi */
let paramCache = {};
try {
  paramCache = JSON.parse(localStorage.getItem("wrsParamCacheV1") || "{}") || {};
} catch {
  paramCache = {};
}
let lastRevisionInfo = null;
let revisionHistory = [];
try {
  const savedRevisionHistory = JSON.parse(localStorage.getItem("wrsRevisionHistoryV1") || "[]");
  if (Array.isArray(savedRevisionHistory)) revisionHistory = savedRevisionHistory.slice(0, 30);
} catch { revisionHistory = []; }

const BASEMAPS = {
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attr: "© OpenStreetMap · © CARTO",
  },
  street: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr: "© OSM",
  },
  sat: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr: "© Esri",
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attr: "© OpenTopoMap",
  },
};

const FAULTS_GEOJSON = {
  type: "FeatureCollection",
  // Representasi jalur sesar/patahan utama Indonesia untuk konteks monitoring.
  // Bukan pengganti dataset geospasial resmi BMKG/PSGN.
  features: [
    { type: "Feature", properties: { name: "Sesar Sumatra" }, geometry: { type: "LineString", coordinates: [[95.3,5.5],[96.0,4.2],[96.8,3.0],[97.5,1.8],[98.2,0.5],[99.0,-0.8],[99.8,-2.0],[100.5,-3.2],[101.2,-4.3],[102.0,-5.2],[103.0,-5.8],[104.2,-6.2]] } },
    { type: "Feature", properties: { name: "Sesar Mentawai" }, geometry: { type: "LineString", coordinates: [[97.4,-0.3],[98.0,-1.1],[98.7,-2.0],[99.4,-2.9],[100.2,-3.7],[101.1,-4.4]] } },
    { type: "Feature", properties: { name: "Sesar Semangko" }, geometry: { type: "LineString", coordinates: [[100.2,5.0],[100.0,3.5],[100.0,2.0],[100.3,0.4],[100.6,-1.2],[101.0,-2.8],[101.3,-4.1],[101.7,-5.1]] } },
    { type: "Feature", properties: { name: "Sesar Baribis" }, geometry: { type: "LineString", coordinates: [[106.1,-6.25],[106.6,-6.3],[107.1,-6.4],[107.8,-6.5],[108.5,-6.6],[109.2,-6.7]] } },
    { type: "Feature", properties: { name: "Sesar Cimandiri" }, geometry: { type: "LineString", coordinates: [[105.5,-7.0],[106.1,-6.95],[106.7,-6.92],[107.2,-6.86],[107.8,-6.8],[108.2,-6.7]] } },
    { type: "Feature", properties: { name: "Sesar Lembang" }, geometry: { type: "LineString", coordinates: [[107.45,-6.83],[107.55,-6.82],[107.68,-6.81],[107.8,-6.79],[107.92,-6.76]] } },
    { type: "Feature", properties: { name: "Sesar Opak" }, geometry: { type: "LineString", coordinates: [[110.20,-7.98],[110.30,-7.92],[110.40,-7.84],[110.50,-7.76],[110.60,-7.68]] } },
    { type: "Feature", properties: { name: "Sesar Kendeng" }, geometry: { type: "LineString", coordinates: [[110.2,-7.25],[111.0,-7.15],[111.8,-7.05],[112.6,-6.95],[113.4,-6.85],[114.2,-6.75]] } },
    { type: "Feature", properties: { name: "Sesar Palu-Koro" }, geometry: { type: "LineString", coordinates: [[119.2,-2.7],[119.5,-2.0],[119.7,-1.2],[119.9,-0.4],[120.1,0.4],[120.3,1.3]] } },
    { type: "Feature", properties: { name: "Sesar Matano" }, geometry: { type: "LineString", coordinates: [[120.6,-2.8],[121.0,-2.5],[121.5,-2.3],[122.0,-2.1],[122.5,-1.9]] } },
    { type: "Feature", properties: { name: "Sesar Walanae" }, geometry: { type: "LineString", coordinates: [[119.7,-4.6],[120.1,-4.3],[120.5,-4.0],[120.9,-3.7],[121.3,-3.4],[121.7,-3.1]] } },
    { type: "Feature", properties: { name: "Flores Back-Arc Thrust" }, geometry: { type: "LineString", coordinates: [[115.2,-8.2],[116.5,-8.0],[117.8,-8.0],[119.0,-8.1],[120.2,-8.2],[121.4,-8.4],[122.6,-8.5],[123.8,-8.4],[125.0,-8.2]] } },
    { type: "Feature", properties: { name: "Banda Arc" }, geometry: { type: "LineString", coordinates: [[124.0,-8.5],[125.2,-8.2],[126.5,-7.7],[127.7,-6.8],[128.8,-5.6],[129.8,-4.2]] } },
    { type: "Feature", properties: { name: "Sorong" }, geometry: { type: "LineString", coordinates: [[129.2,-0.4],[130.4,-0.6],[131.5,-0.8],[132.7,-1.0],[133.9,-1.2],[135.0,-1.3]] } },
    { type: "Feature", properties: { name: "Yapen" }, geometry: { type: "LineString", coordinates: [[135.2,-1.5],[136.1,-1.7],[137.1,-1.9],[138.0,-2.1]] } },
    { type: "Feature", properties: { name: "Tarera-Aiduna" }, geometry: { type: "LineString", coordinates: [[136.0,-3.2],[137.0,-3.5],[138.0,-3.8],[139.0,-4.1]] } },
    { type: "Feature", properties: { name: "Seram" }, geometry: { type: "LineString", coordinates: [[128.0,-3.0],[128.8,-3.1],[129.7,-3.0],[130.6,-2.8],[131.4,-2.5]] } },
    { type: "Feature", properties: { name: "Sunda Megathrust" }, geometry: { type: "LineString", coordinates: [[95.0,6.0],[96.5,4.5],[98.0,2.5],[100.0,0.0],[102.0,-2.5],[104.0,-5.0],[106.0,-7.0],[108.0,-8.5],[110.0,-9.5],[112.0,-10.0],[115.0,-10.5],[118.0,-11.0],[122.0,-10.5]] } },
  ],
};

function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, ".").trim());
  return Number.isFinite(n) ? n : NaN;
}
function parseLS(s) {
  if (s == null) return NaN;
  const str = String(s).trim();
  const n = parseFloat(str.replace(/,/g, "."));
  if (!Number.isFinite(n)) return NaN;
  if (/LS|S\b/i.test(str)) return -Math.abs(n);
  if (/LU|N\b/i.test(str)) return Math.abs(n);
  return n;
}
function parseBT(s) {
  if (s == null) return NaN;
  const str = String(s).trim();
  const n = parseFloat(str.replace(/,/g, "."));
  if (!Number.isFinite(n)) return NaN;
  if (/BB|W\b/i.test(str)) return -Math.abs(n);
  return Math.abs(n);
}
function parseDepth(s) {
  const m = String(s ?? "").match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : "—";
}
function shakemapUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^\/+/, "");
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i, SHAKEMAP_BASE);
  }
  return SHAKEMAP_BASE + s;
}

/** Tebak URL shakemap dari waktu (WIB) bila field Shakemap kosong */
function shakemapFromTime(isoOrLocal) {
  if (!isoOrLocal) return null;
  const t = String(isoOrLocal).trim();
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 14) return shakemapUrl(digits.slice(0, 14) + ".mmi.jpg");
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const w = new Date(d.getTime() + 7 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  const id =
    w.getUTCFullYear() +
    pad(w.getUTCMonth() + 1) +
    pad(w.getUTCDate()) +
    pad(w.getUTCHours()) +
    pad(w.getUTCMinutes()) +
    pad(w.getUTCSeconds());
  return shakemapUrl(id + ".mmi.jpg");
}

function normPublic(raw) {
  if (!raw) return null;
  let lat = NaN, lon = NaN;
  const coord = raw.Coordinates ?? raw.coordinates;
  if (coord) {
    const text = String(coord).trim();
    const p = text.split(",");
    if (p.length >= 2) {
      lat = parseLS(p[0]);
      lon = parseBT(p[1]);
    } else {
      const latToken = text.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:LS|LU|S|N)\b/i)?.[0];
      const lonToken = text.match(/[+-]?\d+(?:[.,]\d+)?\s*(?:BT|BB|E|W)\b/i)?.[0];
      if (latToken) lat = parseLS(latToken);
      if (lonToken) lon = parseBT(lonToken);
    }
  }
  if (!Number.isFinite(lat)) lat = parseLS(raw.Lintang);
  if (!Number.isFinite(lon)) lon = parseBT(raw.Bujur);
  const magnitude = num(raw.Magnitude ?? raw.magnitude);
  if (!Number.isFinite(magnitude)) return null;
  return {
    key: "pub|" + (raw.DateTime || `${raw.Tanggal}|${raw.Jam}|${magnitude}|${lat}|${lon}`),
    magnitude,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    place: String(raw.Wilayah || "Indonesia").trim(),
    depth: parseDepth(raw.Kedalaman),
    time: String(raw.DateTime || "").trim(),
    potential: String(raw.Potensi || "—").trim(),
    felt: String(raw.Dirasakan || "").trim(),
    status: "BMKG", source: "BMKG", official: true,
    shakemap: shakemapUrl(raw.Shakemap ?? raw.shakemap) || shakemapFromTime(raw.DateTime),
    timesent: raw.DateTime || "",
  };
}

function normQL(f) {
  if (!f?.properties || !f?.geometry) return null;
  const p = f.properties;
  const c = f.geometry.coordinates || [];
  const lon = num(c[0]), lat = num(c[1]);
  const magnitude = num(p.mag ?? p.magnitude);
  if (!Number.isFinite(magnitude) || magnitude < 1.5) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const depth = parseDepth(p.depth);
  const time = String(p.time || "").trim();
  const place = String(p.place || "Indonesia").trim();
  const id = String(p.id || `${time}|${magnitude}|${lat}|${lon}`);
  return {
    key: "ql|" + id, magnitude: Math.round(magnitude * 10) / 10,
    lat, lon, place, depth, time,
    potential: "—", felt: "", status: String(p.status || "M"),
    source: "InaTEWS", shakemap: null,
  };
}

async function fetchClientSide() {
  const UA = { Accept: "application/json" };
  const urls = [
    "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
    "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
    "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json",
  ];
  const pub = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url + "?t=" + Date.now(), {
        headers: UA, cache: "no-store", signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) return;
      const j = await r.json();
      const g = j?.Infogempa?.gempa;
      if (Array.isArray(g)) g.forEach((x) => { const n = normPublic(x); if (n) pub.push(n); });
      else if (g) { const n = normPublic(g); if (n) pub.push(n); }
    } catch { /* skip */ }
  }));

  // Jalur langsung cadangan: coba feed live lastQL, bukan hanya katalog gempaQL.
  let wrsLive = [];
  let wrsFeedOk = false;
  try {
    const r = await fetch("https://bmkg-content-inatews.storage.googleapis.com/lastQL.json?t=" + Date.now(), {
      headers: UA, cache: "no-store", signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      wrsFeedOk = true;
      const j = await r.json();
      const features = Array.isArray(j?.features) ? j.features : j?.type === "Feature" ? [j] : Array.isArray(j) ? j : [];
      wrsLive = features.map(normQL).filter(Boolean).map(q => ({
        ...q, source: "InaTEWS WRS", status: "InaTEWS WRS", wrsRealtime: true
      }));
    }
  } catch { /* feed live cadangan opsional */ }

  let ql = [];
  try {
    const r = await fetch("https://bmkg-content-inatews.storage.googleapis.com/gempaQL.json?t=" + Date.now(), {
      headers: UA, cache: "no-store", signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const j = await r.json();
      ql = (j.features || []).map(normQL).filter(Boolean);
    }
  } catch { /* skip */ }

  // Global USGS feed: keep Indonesia-first BMKG/InaTEWS data, plus worldwide M5+
  // events and events flagged by USGS as tsunami-related.
  let usgs = [];
  try {
    const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson?t=" + Date.now(), {
      headers: UA, cache: "no-store", signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const j = await r.json();
      usgs = (j.features || []).flatMap((f) => {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates || [];
        const magnitude = num(p.mag), lon = num(coords[0]), lat = num(coords[1]);
        const tsunami = Number(p.tsunami) === 1;
        if ((!Number.isFinite(magnitude) || magnitude < 5) && !tsunami) return [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        const time = p.time ? new Date(p.time).toISOString() : "";
        return [{
          key: "usgs|" + String(f.id || p.code || (time + "|" + lat + "|" + lon)),
          eventid: String(f.id || p.code || ""),
          magnitude: Number.isFinite(magnitude) ? Math.round(magnitude * 10) / 10 : 0,
          lat, lon, place: String(p.place || "Gempa global"),
          depth: Number.isFinite(num(coords[2])) ? String(num(coords[2])) : "—",
          time, potential: tsunami ? "USGS menandai event terkait tsunami — periksa bulletin resmi" : "—",
          felt: "", status: "USGS", source: "USGS", official: false,
          isTsunamiWarning: false, usgsTsunamiFlag: tsunami, detailUrl: String(p.url || ""), detailApiUrl: String(p.detail || ""), usgsEventId: String(f.id || p.code || "")
        }];
      });
    }
  } catch { /* USGS is supplemental; retain BMKG/InaTEWS data */ }

  const byKey = new Map();
  const sig = new Set();
  const all = [...wrsLive, ...pub, ...ql, ...usgs].sort((a, b) => new Date(b.time) - new Date(a.time));
  for (const q of all) {
    if (byKey.has(q.key)) continue;
    const s = `${q.magnitude.toFixed(1)}|${(q.place || "").slice(0, 30)}|${String(q.time).slice(0, 16)}`;
    if (sig.has(s)) continue;
    byKey.set(q.key, q);
    sig.add(s);
  }
  const recent = [...byKey.values()].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 600);
  const official = pub.filter((q) => q.official).sort((a, b) => new Date(b.time) - new Date(a.time));
  const realtimeEvents = wrsLive
    .filter(q => Number.isFinite(q.lat) && Number.isFinite(q.lon) && q.lat >= -11 && q.lat <= 6.5 && q.lon >= 94 && q.lon <= 141.5)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  return {
    ok: true, recent,
    official: official[0] || recent.find((q) => q.official) || recent[0] || null,
    realtime: realtimeEvents[0] || null,
    realtimeEvents,
    count: recent.length,
    sources: {
      client: true, public: pub.length, inaQL: ql.length,
      wrs: { ok: wrsFeedOk, eventCount: realtimeEvents.length },
      errors: wrsFeedOk ? [] : ["Feed realtime WRS langsung belum terverifikasi"]
    },
  };
}

function setBasemap(key) {
  if (baseLayer) map.removeLayer(baseLayer);
  const bm = BASEMAPS[key] || BASEMAPS.sat;
  baseLayer = L.tileLayer(bm.url, { maxZoom: 12, attribution: bm.attr }).addTo(map);
  document.querySelectorAll(".bm-opt").forEach((b) => b.classList.toggle("active", b.dataset.bm === key));
  localStorage.setItem("wrsBasemap", key);
}

function initMap() {
  // Canvas dipakai untuk marker agar pan/zoom tetap ringan. Sesar dibuat static sederhana.
  map = L.map("map", { zoomControl: true, preferCanvas: true, renderer: L.canvas({ padding: 0.5 }) }).setView([-3.5, 118], 5);
  const savedRaw = localStorage.getItem("wrsBasemap");
  const saved = savedRaw === "dark" || !BASEMAPS[savedRaw] ? "sat" : savedRaw;
  setBasemap(saved);

  // Nonaktifkan cluster angka: tampilkan tiap gempa sebagai titik bulat berwarna.
  // Ini mempertahankan tampilan titik individual seperti versi awal.
  markers = L.layerGroup().addTo(map);
  // Lapisan terpisah menjaga bintang terbaru dan cincin denyut selalu terlihat.
  radiusLayer = L.layerGroup().addTo(map);
  latestStarLayer = L.layerGroup().addTo(map);
  tsunamiMapLayer = L.layerGroup().addTo(map);

  faultLayer = L.geoJSON(FAULTS_GEOJSON, {
    style: {
      color: "#ef4444",
      weight: 2,
      opacity: 0.82,
      lineCap: "round",
      lineJoin: "round",
    },
    onEachFeature: (f, layer) => {
      if (f.properties?.name) layer.bindTooltip(f.properties.name, { sticky: true, opacity: 0.9 });
    },
  }).addTo(map);

  miniMap = L.map("miniFocus", {
    zoomControl: false, attributionControl: false,
    dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
  }).setView([-3.5, 118], 4);
  L.tileLayer(BASEMAPS.sat.url, { maxZoom: 18, attribution: BASEMAPS.sat.attr }).addTo(miniMap);
}

function depthColor(d) {
  const n = parseFloat(d);
  if (!Number.isFinite(n)) return "#ef4444";
  if (n <= 50) return "#ef4444";
  if (n <= 100) return "#eab308";
  if (n <= 250) return "#86efac";
  if (n <= 600) return "#16a34a";
  return "#1e3a8a";
}

/** Ukuran marker diselaraskan legenda magnitudo (lebih mudah dibedakan) */
function radius(m) {
  const x = Number(m) || 0;
  if (x >= 8) return 18;
  if (x >= 7) return 15;
  if (x >= 6) return 13;
  if (x >= 5) return 11;
  if (x >= 4) return 9;
  if (x >= 3) return 7;
  if (x >= 2) return 5.5;
  return 4;
}

/** Warna isi marker ≈ legenda magnitudo (lebih mudah dibaca) */
function magColor(m) {
  const x = Number(m) || 0;
  if (x >= 8) return "#7c3aed";
  if (x >= 7) return "#b91c1c";
  if (x >= 6) return "#dc2626";
  if (x >= 5) return "#ef4444";
  if (x >= 4) return "#f59e0b";
  if (x >= 3) return "#fbbf24";
  if (x >= 2) return "#60a5fa";
  return "#6b7280";
}

function fmtCoord(q) {
  if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) return "—";
  const ns = q.lat >= 0 ? "LU" : "LS";
  const ew = q.lon >= 0 ? "BT" : "BB";
  return `${Math.abs(q.lat).toFixed(2)} ${ns}, ${Math.abs(q.lon).toFixed(2)} ${ew}`;
}

function fmtTime(q) {
  if (!q.time) return "—";
  const d = new Date(q.time);
  if (Number.isNaN(d.getTime())) return String(q.time);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(d) + " WIB";
}

function timeAgo(q) {
  if (!q.time) return "—";
  const d = new Date(q.time);
  if (Number.isNaN(d.getTime())) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `⏰ ${sec} detik yang lalu`;
  if (sec < 3600) return `⏰ ${Math.floor(sec / 60)} menit yang lalu`;
  if (sec < 86400) return `⏰ ${Math.floor(sec / 3600)} jam yang lalu`;
  return `⏰ ${Math.floor(sec / 86400)} hari yang lalu`;
}

function shortDate(q) {
  if (!q.time) return "—";
  const d = new Date(q.time);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(d);
}

function parseMmi(felt) {
  if (!felt || typeof felt !== "string") return [];
  const items = [];
  const parts = felt.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^(I{1,3}V?|IV|V|VI|VII|VIII|IX|X|XI|XII)(?:\s*[-–]\s*(I{1,3}V?|IV|V|VI|VII|VIII|IX|X))?\s+(.+)$/i);
    if (m) {
      const scale = m[2] ? `${m[1]}-${m[2]}` : m[1];
      items.push({ scale: scale.toUpperCase(), place: m[3].trim() });
    } else if (p.length > 2) {
      items.push({ scale: "—", place: p });
    }
  }
  return items;
}

function isTsunamiPotential(pot) {
  if (!pot) return false;
  const s = String(pot).toLowerCase();
  // USGS's tsunami flag indicates an event classification, not an active warning.
  // Never turn that flag alone into a BMKG/InaTEWS warning or alarm.
  if (/usgs\s*:/.test(s) && /bukan\s*otomatis\s*peringatan\s*aktif/.test(s)) return false;
  return /tsunami|berpotensi|awas|siaga|waspada/i.test(s) &&
    !/tidak\s*(ada\s*)?berpotensi|tidak\s*ada\s*potensi|tidak ada potensi|bukan\s*otomatis\s*peringatan\s*aktif/i.test(s);
}

/* Kept as a compatibility hook; decorative radius rings are intentionally disabled. */
function drawRadiusRings() {
  if (radiusLayer) radiusLayer.clearLayers();
}

function getFilteredQuakes() {
  const now = Date.now();
  const maxAge = Number(filterState.age || 168) * 3600000;
  return quakes.filter((q) => {
    if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) return false;
    if (q.magnitude < Number(filterState.mag || 1.5)) return false;
    if (filterState.source !== "ALL" && q.source !== filterState.source) return false;
    if (q.time) {
      const t = new Date(q.time).getTime();
      if (Number.isFinite(t) && now - t > maxAge) return false;
    }
    const dep = parseFloat(q.depth);
    if (filterState.depth === "shallow" && (!Number.isFinite(dep) || dep > 50)) return false;
    if (filterState.depth === "mid" && (!Number.isFinite(dep) || dep <= 50 || dep > 300)) return false;
    if (filterState.depth === "deep" && (!Number.isFinite(dep) || dep <= 300)) return false;
    return true;
  });
}

function updateStats(list) {
  const all = quakes;
  const strong = all.filter(q => q.magnitude >= 4).length;
  const felt = all.filter(q => q.felt && String(q.felt).trim()).length;
  // Prioritas: daftar resmi InaTEWS last-30 tsunami; fallback potensi di katalog
  const tsunami =
    tsunamiHistory.length ||
    all.filter((q) => isTsunamiPotential(q.potential)).length;
  const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
  set("#statTotal", list.length);
  set("#statStrong", strong);
  set("#statFelt", felt);
  set("#statTsunami", tsunami);
  const fc = $("#filterCount");
  if (fc) fc.textContent = `${list.length} dari ${all.length} event`;
}

function drawMarkers(force = false) {
  const list = getFilteredQuakes();
  updateStats(list);
  const fp = `${filterState.mag}|${filterState.age}|${filterState.source}|${filterState.depth}|${list.map(q => q.key).join(",")}`;
  if (!force && fp === lastRenderFingerprint) return;
  lastRenderFingerprint = fp;
  markers.clearLayers();
  if (radiusLayer) radiusLayer.clearLayers();
  if (latestStarLayer) latestStarLayer.clearLayers();

  // Kembalikan marker gempa ke bentuk lingkaran berwarna berdasarkan magnitudo.
  // Event terbaru tetap diberi bintang merah berdenyut dan cincin pulse.
  const preferredLatest = filterState.source === "ALL" ? primaryRealtimeQuake() : list[0];
  const equivalentLatest = preferredLatest && list.find(q => {
    if (q.key === preferredLatest.key) return true;
    const valid = Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon)) &&
      Number.isFinite(Number(preferredLatest.lat)) && Number.isFinite(Number(preferredLatest.lon));
    if (!valid) return false;
    const samePlace = Math.abs(Number(q.lat)-Number(preferredLatest.lat)) <= 0.5 &&
      Math.abs(Number(q.lon)-Number(preferredLatest.lon)) <= 0.5;
    const sameMag = Math.abs(Number(q.magnitude)-Number(preferredLatest.magnitude)) <= 0.8;
    const tq = new Date(q.time || 0).getTime(), tp = new Date(preferredLatest.time || 0).getTime();
    return samePlace && sameMag && Number.isFinite(tq) && Number.isFinite(tp) && Math.abs(tq-tp) <= 5*60*1000;
  });
  const latestKey = equivalentLatest?.key || list[0]?.key;
  list.slice(0, 800).forEach((q) => {
    const latest = q.key === latestKey;
    const fill = magColor(q.magnitude);
    const edge = depthColor(q.depth);
    const size = radius(q.magnitude);

    const marker = L.circleMarker([q.lat, q.lon], {
      radius: size,
      // Warna tepi selalu mengikuti kedalaman; bintang terpisah menandai gempa terbaru.
      color: edge,
      weight: latest ? 2.5 : 1.5,
      opacity: 1,
      fillColor: fill,
      fillOpacity: 0.9,
      bubblingMouseEvents: false,
    });
    marker.bindTooltip(
      '<b>M' + Number(q.magnitude).toFixed(1) + '</b> · kedalaman ' + q.depth + ' km<br><span style="opacity:.85">' + (q.place || "") + '</span>',
      { sticky: true, opacity: 0.96 }
    );
    marker.on("click", () => openModal(q));
    marker.addTo(markers);

    if (latest) {
      const starIcon = L.divIcon({
        className: "eq-star-marker",
        html: '<span class="eq-star" aria-label="Gempa terbaru">★</span>',
        iconSize: [38, 40],
        iconAnchor: [19, 20],
      });
      L.marker([q.lat, q.lon], {
        icon: starIcon,
        keyboard: false,
        interactive: false,
        zIndexOffset: 3000,
      }).addTo(latestStarLayer);

      // Pulse ring dibuat dengan SVG renderer agar animasinya berjalan stabil.
      [12000, 24000].forEach((meters, index) => {
        L.circle([q.lat, q.lon], {
          radius: meters,
          color: "#ff3030",
          weight: 2,
          opacity: 0.8,
          fillColor: "#ff3030",
          fillOpacity: 0.035,
          interactive: false,
          className: "eq-radius-ring",
          renderer: L.svg(),
        }).addTo(radiusLayer);
      });
    }
  });
  if (userLocation) updateUserMarker(false);
}
/** ID stabil event (abaikan magnitudo di key) supaya revisi parameter terdeteksi */
function stableEventId(q) {
  if (!q) return "";
  if (q.eventid) return String(q.eventid);
  // key sering "ql|id" / "dg|id" — potong bagian magnitudo kalau ada
  const k = String(q.key || "");
  if (k && !/\|[\d.]+$/.test(k.split("|").pop() || "")) return k;
  const t = q.time ? new Date(q.time).getTime() : 0;
  const minute = Number.isFinite(t) ? Math.floor(t / 60000) : 0;
  const lat = Number.isFinite(q.lat) ? q.lat.toFixed(2) : "?";
  const lon = Number.isFinite(q.lon) ? q.lon.toFixed(2) : "?";
  return `${minute}|${lat}|${lon}`;
}

function snapshotParams(q) {
  return {
    magnitude: Number(q.magnitude),
    depth: Number(q.depth),
    lat: Number(q.lat),
    lon: Number(q.lon),
    potential: String(q.potential || ""),
    place: String(q.place || ""),
    ts: Date.now(),
  };
}

/**
 * Bandingkan dengan cache → null | { significant, parts, prev, next }
 */
function detectRevision(q) {
  const id = stableEventId(q);
  if (!id) return null;
  const prev = paramCache[id];
  const next = snapshotParams(q);
  if (!prev) {
    paramCache[id] = next;
    return null;
  }
  const parts = [];
  const dM = Math.abs(next.magnitude - prev.magnitude);
  const dD = Math.abs(next.depth - prev.depth);
  const dLat = Math.abs(next.lat - prev.lat);
  const dLon = Math.abs(next.lon - prev.lon);
  if (dM >= 0.05) {
    parts.push(`M${prev.magnitude.toFixed(1)}→${next.magnitude.toFixed(1)}`);
  }
  if (dD >= 1) {
    parts.push(`kedalaman ${prev.depth}→${next.depth} km`);
  }
  if (dLat >= 0.05 || dLon >= 0.05) {
    parts.push("lokasi diperbarui");
  }
  const potPrev = isTsunamiPotential(prev.potential);
  const potNext = isTsunamiPotential(next.potential);
  if (potPrev !== potNext) {
    parts.push(potNext ? "status tsunami aktif" : "status tsunami dicabut");
  }
  paramCache[id] = next;
  if (!parts.length) return null;
  const significant =
    dM >= 0.3 ||
    (prev.magnitude < 5 && next.magnitude >= 5) ||
    (prev.magnitude >= 5 && next.magnitude < 5) ||
    potPrev !== potNext ||
    dD >= 15 ||
    dLat >= 0.15 ||
    dLon >= 0.15;
  return { id, significant, parts, prev, next, dM };
}

function saveParamCache() {
  try {
    const ids = Object.keys(paramCache);
    if (ids.length > 400) {
      const sorted = ids.sort((a, b) => (paramCache[a].ts || 0) - (paramCache[b].ts || 0));
      sorted.slice(0, ids.length - 300).forEach((id) => delete paramCache[id]);
    }
    localStorage.setItem("wrsParamCacheV1", JSON.stringify(paramCache));
  } catch {}
}

function showRealtimeUpdate(info, append = false) {
  const el = $("#rtUpdate");
  if (!el) return;
  if (info?.parts?.length && append) {
    const fingerprint = [info.id, info.next?.magnitude, info.next?.depth, info.next?.lat, info.next?.lon, info.parts.join("|")].join("::");
    if (!revisionHistory.some(item => item.fingerprint === fingerprint)) {
      revisionHistory.unshift({
        fingerprint,
        id: info.id,
        place: String(info.place || "Lokasi tidak diketahui"),
        parts: info.parts.slice(),
        significant: !!info.significant,
        magnitude: Number(info.next?.magnitude),
        depth: info.next?.depth,
        time: new Date().toISOString()
      });
      revisionHistory = revisionHistory.slice(0, 30);
      try { localStorage.setItem("wrsRevisionHistoryV1", JSON.stringify(revisionHistory)); } catch {}
    }
    lastRevisionInfo = info;
  }
  if (!revisionHistory.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("rev-big", revisionHistory.some(item => item.significant));
  const escapeRealtimeText = value => String(value == null ? "—" : value).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const rows = revisionHistory.map((item) => {
    const tag = item.significant ? "REVISI BESAR" : "PEMUTAKHIRAN";
    const stamp = new Date(item.time).toLocaleTimeString("id-ID", {hour:"2-digit",minute:"2-digit",second:"2-digit"});
    return `<div class="rt-upd-row"><span class="rt-upd-tag">${tag}</span><span class="rt-upd-txt">${escapeRealtimeText(item.place)} · ${item.parts.map(escapeRealtimeText).join(" · ")}</span><time class="rt-upd-time">${stamp}</time></div>`;
  }).join("");
  el.innerHTML = `<div class="rt-upd-heading">RIWAYAT PEMUTAKHIRAN PARAMETER · ${revisionHistory.length}</div>${rows}`;
}

function primaryRealtimeQuake() {
  const valid = q => q && Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon));
  // The realtime card follows the dedicated InaTEWS/WRS feed, not the newest
  // record in the merged BMKG/USGS catalog.
  // Jangan menyamarkan katalog/riwayat sebagai kejadian realtime.
  return valid(currentRealtime) ? currentRealtime : null;
}

// Native Android WebView calls this after its first data load. The map and quake
// records live in this module's lexical scope, so expose a small safe focus API.
window.wrsFocusLatestQuake = function () {
  try {
    if (!map || typeof map.setView !== "function") return false;
    const valid = q => q &&
      Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon)) &&
      Number(q.lat) >= -90 && Number(q.lat) <= 90 &&
      Number(q.lon) >= -180 && Number(q.lon) <= 180;
    const q = primaryRealtimeQuake() ||
      quakes.filter(valid).sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))[0];
    if (!valid(q)) return false;
    map.invalidateSize({ animate: false });
    map.setView([Number(q.lat), Number(q.lon)], 6, { animate: false });
    return true;
  } catch (_) {
    return false;
  }
};

function renderRealtime(q) {
  const el = $("#rtMag");
  if (!q) {
    if (el) {
      el.textContent = "—";
      el.style.background = "linear-gradient(145deg, #33415555, #0d2038)";
      el.style.borderColor = "#64748b";
      el.style.color = "#cbd5e1";
    }
    if ($("#rtDate")) $("#rtDate").textContent = "Feed realtime belum tersedia";
    if ($("#rtAgo")) $("#rtAgo").textContent = "Menunggu data live";
    if ($("#rtCoord")) $("#rtCoord").textContent = "—";
    if ($("#rtPlace")) $("#rtPlace").textContent = "Belum ada event dari feed realtime InaTEWS/WRS";
    if ($("#rtSrc")) $("#rtSrc").textContent = "Sumber: menunggu feed realtime";
    updateRealtimeDistance();
    return;
  }
  if (!el) return;
  el.textContent = q.magnitude.toFixed(1);
  el.style.background = `linear-gradient(145deg, ${magColor(q.magnitude)}55, #0d2038)`;
  el.style.borderColor = magColor(q.magnitude);
  el.style.color = q.magnitude >= 5 ? "#fecaca" : "#7ef9ff";
  $("#rtDate").textContent = shortDate(q);
  $("#rtAgo").textContent = timeAgo(q);
  $("#rtCoord").textContent = `◎ ${fmtCoord(q)} · ${q.depth} Km`;
  $("#rtPlace").textContent = q.place;
  $("#rtSrc").textContent = `Sumber: ${q.source || "BMKG"}`;
  // Riwayat pemutakhiran tetap tampil di kotak katalog realtime walau
  // revisi terjadi pada event lain dalam daftar WRS tujuh hari.
  showRealtimeUpdate(null, false);
  updateRealtimeDistance();
}

/** Parse daftar daerah dari deskripsi buletin tsunami BMKG */
function parseTsunamiZones(q) {
  const text = [q.description, q.headline, q.felt].filter(Boolean).join(" ; ");
  const items = [];
  // Pola: NAMA-DAERAH(05:41WIB)0.14m
  const re = /([A-Za-z][A-Za-z0-9./\-]{2,40}?)\s*\((\d{1,2}:\d{2}\s*WIB)\)\s*([\d.]+)\s*m/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const height = parseFloat(m[3]);
    let level = "waspada";
    if (height > 3) level = "awas";
    else if (height >= 0.5) level = "siaga";
    items.push({
      name: m[1].trim().replace(/\s+/g, " "),
      eta: m[2].replace(/\s+/g, ""),
      height: height,
      level,
    });
  }
  if (!items.length && q.felt) {
    parseMmi(q.felt).forEach((it) => {
      items.push({
        name: it.place,
        eta: "-",
        height: null,
        level: classifyAreaLevel(it.scale),
      });
    });
  }
  return items;
}

function renderTsunamiZoneTable(q) {
  const box = $("#tsunamiZoneTable");
  if (!box) return;
  const items = parseTsunamiZones(q);
  if (!items.length) {
    box.innerHTML =
      '<div class="tz-empty">Detail nama daerah per zona belum tercantum di buletin ini. Lihat peta Warning Zone / SSHmax di atas.</div>';
    return;
  }
  const order = { awas: 0, siaga: 1, waspada: 2 };
  items.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  const rows = items
    .map((it) => {
      const lbl = it.level === "awas" ? "AWAS" : it.level === "siaga" ? "SIAGA" : "WASPADA";
      const h = it.height != null ? it.height.toFixed(2) + " m" : "-";
      return (
        '<div class="tz-row tz-' +
        it.level +
        '"><span class="tz-badge">' +
        lbl +
        '</span><span class="tz-name">' +
        it.name +
        '</span><span class="tz-meta">' +
        it.eta +
        '</span><span class="tz-h">' +
        h +
        "</span></div>"
      );
    })
    .join("");
  box.innerHTML =
    '<div class="tz-head"><span></span><span>Daerah</span><span>Estimasi tiba</span><span>Tinggi</span></div>' +
    rows;
}

function shakeMapSourceLabel(q) {
  if (q?.shakemapSource) return String(q.shakemapSource);
  if (q?.source === "USGS" || String(q?.key || "").startsWith("usgs|")) return "USGS ShakeMap";
  return "BMKG / InaTEWS";
}
function updateShakeMapLabels(q) {
  const label = shakeMapSourceLabel(q);
  const mainHeading = $("#shakemapBox .rp-shakemap-h");
  const modalHeading = $("#modalShakemapBox .mmi-h");
  const tsunamiHeading = $("#tsunamiShakemapBox .mmi-h");
  if (mainHeading) mainHeading.textContent = "ShakeMap (Peta Guncangan) · " + label;
  if (modalHeading) modalHeading.textContent = "ShakeMap · " + label;
  if (tsunamiHeading) tsunamiHeading.textContent = "ShakeMap · " + label;
  const mainImage = $("#shakemapImg");
  const modalImage = $("#modalShakemapImg");
  if (mainImage) mainImage.alt = "ShakeMap MMI · " + label;
  if (modalImage) modalImage.alt = "ShakeMap MMI · " + label;
}

function renderOfficial(q) {
  if (!q) return;
  currentOfficial = q;
  updateShakeMapLabels(q);
  $("#offMag").textContent = q.magnitude.toFixed(1).replace(".", ",");
  $("#offTitle").textContent = q.felt || /dirasakan/i.test(q.potential || "")
    ? "INFO GEMPA DIRASAKAN"
    : q.magnitude >= 5 ? "INFO GEMPA M≥5" : "INFO GEMPA";
  $("#offSent").textContent = q.timesent ? "waktu kirim: " + q.timesent : fmtTime(q);
  $("#offTime").textContent = fmtTime(q);
  $("#offCoord").textContent = fmtCoord(q);
  $("#offDepth").textContent = q.depth + " Km";

  const desc = q.headline ||
    `Info Gempa Mag:${q.magnitude.toFixed(1)}, ${fmtTime(q)}, Lok:${fmtCoord(q)} (${q.place}), Kedlmn:${q.depth} Km ::${q.source || "BMKG"}`;
  $("#offDesc").textContent = desc;

  const isUsgsEvent = q.source === "USGS" || String(q.key || "").startsWith("usgs|");
  const isInatewsEvent = /INATEWS|WRS/i.test(String(q.source || ""));
  const pot = q.potential && q.potential !== "—"
    ? q.potential
    : isUsgsEvent
      ? "USGS tidak menandai kejadian terkait tsunami pada data ini. Ini bukan konfirmasi ketiadaan risiko; periksa peringatan resmi setempat."
      : q.felt ? "Gempa ini dirasakan untuk diteruskan pada masyarakat" : "Tidak ada potensi tsunami menurut informasi yang tersedia.";
  const potEl = $("#offPot");
  potEl.textContent = pot;
  if (isTsunamiPotential(pot)) {
    potEl.style.background = "linear-gradient(135deg,#3f0a0a,#1a0505)";
    potEl.style.borderColor = "rgba(220,50,50,.55)";
    potEl.style.color = "#fecaca";
    potEl.style.animation = "";
  } else {
    potEl.style.background = "linear-gradient(135deg,#052e16,#021a0c)";
    potEl.style.borderColor = "rgba(34,197,94,.4)";
    potEl.style.color = "#bbf7d0";
    potEl.style.animation = "none";
  }

  const offInstrHeading = $("#offInstr b");
  if (offInstrHeading) offInstrHeading.textContent = isUsgsEvent
    ? "Saran keselamatan (USGS)"
    : isInatewsEvent ? "Informasi dari InaTEWS / WRS" : "Saran & Instruksi BMKG";
  $("#offInstr span").textContent = q.instruction || (isUsgsEvent
    ? "Waspadai gempa susulan dan ikuti arahan otoritas kebencanaan setempat. Data USGS bukan pengganti peringatan resmi."
    : "Hati-hati terhadap gempabumi susulan yang mungkin terjadi");

  const smBox = $("#shakemapBox");
  const smImg = $("#shakemapImg");
  if (q.shakemap) {
    smImg.src = q.shakemap;
    smBox.classList.remove("hidden");
  } else {
    smBox.classList.add("hidden");
    smImg.removeAttribute("src");
  }

  const detailBtn = $("#btnDetail");
  if (detailBtn) {
    detailBtn.classList.remove("hidden");
    detailBtn.onclick = () => {
      showLoading("Membuka detail…");
      setTimeout(() => {
        openModal(q);
        hideLoading();
      }, 280);
    };
  }

  if (Number.isFinite(q.lat) && Number.isFinite(q.lon)) {
    miniMap.setView([q.lat, q.lon], 6);
    if (miniMarker) miniMap.removeLayer(miniMarker);
    const miniSize = Math.max(12, Math.min(18, Math.round(9 + Number(q.magnitude || 0))));
    miniMarker = L.marker([q.lat, q.lon], {
      icon: L.divIcon({
        className: "quake-marker-wrap",
        html: '<span class="quake-diamond is-latest" style="--quake-fill:' + magColor(q.magnitude) + ';--quake-edge:' + depthColor(q.depth) + ';--quake-size:' + miniSize + 'px" aria-hidden="true"></span>',
        iconSize: [miniSize + 8, miniSize + 8],
        iconAnchor: [(miniSize + 8) / 2, (miniSize + 8) / 2]
      }),
      keyboard: false,
      interactive: false
    }).addTo(miniMap);
  }
}


// ===== Detail gempa bergaya laporan BMKG + pencarian sumber cadangan =====
function ensureUsgsProductsBox() {
  let box = document.getElementById("usgsProductsBox");
  if (box) return box;
  const smBox = document.getElementById("modalShakemapBox");
  if (!smBox?.parentElement) return null;
  box = document.createElement("section");
  box.id = "usgsProductsBox";
  box.className = "usgs-products-box";
  box.style.cssText = "margin-top:14px;padding:14px;border:1px solid var(--border, #cbd5e1);border-radius:12px;background:var(--surface-2, rgba(148,163,184,.08));color:inherit";
  smBox.insertAdjacentElement("afterend", box);
  return box;
}
function usgsProductLabel(type) {
  return ({
    shakemap: "ShakeMap · peta intensitas guncangan",
    dyfi: "Laporan gempa dirasakan (DYFI)",
    losspager: "Estimasi dampak (PAGER)",
    "moment-tensor": "Analisis moment tensor",
    "focal-mechanism": "Mekanisme patahan",
    "finite-fault": "Model patahan",
    "ground-failure": "Estimasi longsor / likuefaksi",
    "phase-data": "Data pengamatan seismik",
    origin: "Parameter sumber gempa",
    "tectonic-summary": "Ringkasan tektonik"
  })[type] || type.replace(/-/g, " ");
}
function getPreferredUsgsProduct(products) {
  if (!Array.isArray(products) || !products.length) return null;
  return [...products].sort((a,b) =>
    Number(b.preferredWeight || 0) - Number(a.preferredWeight || 0) ||
    Number(b.updateTime || 0) - Number(a.updateTime || 0)
  )[0];
}
async function loadUsgsProducts(q, forceFallback = false) {
  if (!q) return;
  // BMKG/InaTEWS tetap prioritas. USGS dicari hanya bila peta MMI resmi BMKG
  // tidak tersedia atau gambar BMKG gagal dimuat.
  const isUsgsEvent = q.source === "USGS" || String(q.key || "").startsWith("usgs|");
  if (q.shakemap && !forceFallback && !isUsgsEvent) return;
  const box = ensureUsgsProductsBox();
  if (!box) return;
  const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  box.innerHTML = '<div style="font-weight:900;font-size:16px;margin-bottom:8px">PETA INTENSITAS GUNCANGAN (MMI)</div><p style="font-size:13px;opacity:.75">Mencari peta MMI cadangan…</p>';
  try {
    let feature = null;
    let eventId = q.usgsEventId || q.eventid || String(q.key || "").replace(/^usgs\|/, "");
    let endpoint = q.detailApiUrl || (isUsgsEvent && eventId
      ? "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/" + encodeURIComponent(eventId) + ".geojson"
      : "");
    if (endpoint) {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (response.ok) feature = await response.json();
    }
    // Jika event berasal dari BMKG dan peta MMI-nya kosong, cari kandidat USGS
    // di sekitar waktu dan lokasi yang sama; jangan pernah mencocokkan hanya dari magnitudo.
    if (!feature && Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon)) && q.time) {
      const t = new Date(q.time).getTime();
      if (Number.isFinite(t)) {
        const params = new URLSearchParams({
          format: "geojson",
          starttime: new Date(t - 4 * 60 * 1000).toISOString(),
          endtime: new Date(t + 4 * 60 * 1000).toISOString(),
          latitude: String(q.lat), longitude: String(q.lon),
          maxradiuskm: "120", minmagnitude: String(Math.max(2.5, Number(q.magnitude || 0) - 1.2)),
          maxmagnitude: String(Number(q.magnitude || 0) + 1.2), orderby: "time"
        });
        const search = await fetch("https://earthquake.usgs.gov/fdsnws/event/1/query?" + params, { cache: "no-store" });
        if (search.ok) {
          const data = await search.json();
          const candidates = (data.features || []).map(f => {
            const c = f.geometry?.coordinates || [];
            const p = f.properties || {};
            const dt = Math.abs(Number(p.time) - t);
            const distance = haversineKm(Number(q.lat), Number(q.lon), Number(c[1]), Number(c[0]));
            const dm = Math.abs(Number(p.mag) - Number(q.magnitude));
            return { f, dt, distance, dm, score: dt / 60000 + distance / 20 + dm * 5 };
          }).filter(x => x.dt <= 4 * 60 * 1000 && x.distance <= 120 && x.dm <= 1.2)
            .sort((a,b) => a.score - b.score);
          if (candidates.length) {
            const candidate = candidates[0].f;
            const id = candidate.id || candidate.properties?.code;
            if (id) {
              const detail = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/" + encodeURIComponent(id) + ".geojson", { cache: "no-store" });
              if (detail.ok) {
                feature = await detail.json();
                eventId = id;
              }
            }
          }
        }
      }
    }
    if (document.getElementById("modalDetail")?.classList.contains("hidden") || window._modalQuake?.key !== q.key) return;
    const p = feature?.properties || {};
    const products = p.products || {};
    // Status dan saran untuk kejadian global bersumber dari metadata USGS,
    // bukan teks default BMKG. Flag tsunami USGS bukan pengganti peringatan resmi.
    const instr = document.getElementById("modalInstrText");
    const tsunamiText = document.getElementById("modalTsunamiText");
    const tsunamiBadge = document.getElementById("modalTsunami");
    if (q.source === "USGS" || String(q.key || "").startsWith("usgs|")) {
      if (instr) {
        const alertLevel = String(p.alert || "").toUpperCase();
        const alertCopy = alertLevel
          ? " Tingkat peringatan dampak USGS: " + alertLevel + "."
          : " USGS tidak menetapkan tingkat peringatan dampak untuk event ini.";
        instr.textContent = "Saran keselamatan: waspadai gempa susulan dan ikuti arahan otoritas kebencanaan setempat." + alertCopy;
      }
      if (tsunamiText && tsunamiBadge) {
        if (Number(p.tsunami) === 1) {
          tsunamiText.textContent = "USGS menandai kejadian ini berpotensi tsunami. Periksa peringatan resmi dari otoritas tsunami setempat; tanda ini bukan konfirmasi bahwa peringatan sedang aktif.";
          tsunamiBadge.classList.remove("safe");
        } else {
          tsunamiText.textContent = "USGS tidak menandai potensi tsunami pada data event ini. Tetap ikuti pengumuman resmi otoritas setempat.";
          tsunamiBadge.classList.add("safe");
        }
      }
    }
    // Cari semua versi ShakeMap, bukan hanya versi preferred; beberapa versi
    // memiliki daftar contents berbeda walau event yang sama.
    const shakeProducts = Array.isArray(products.shakemap) ? [...products.shakemap].sort((a,b) =>
      Number(b.preferredWeight || 0) - Number(a.preferredWeight || 0) ||
      Number(b.updateTime || 0) - Number(a.updateTime || 0)
    ) : [];
    const shakeEntries = shakeProducts.flatMap(product =>
      Object.entries(product?.contents || {}).filter(([, item]) => item?.url)
    );
    // Utamakan gambar intensity.jpg (MMI), lalu nama MMI lain, baru thumbnail.
    // Tampilkan satu peta saja: MMI/intensity. Jika gambar utama gagal dimuat,
    // coba alternatif MMI yang tersedia; jangan menampilkan PGA/PGV/PSA sebagai MMI.
    const mmiCandidates = shakeEntries.filter(([path, item]) =>
      item?.url && /\.(?:jpg|jpeg|png)$/i.test(path) &&
      /(?:^|\/)(?:intensity|mmi|intensity_overlay|ii_thumbnail|pin-thumbnail)\.(?:jpg|jpeg|png)$/i.test(path)
    ).sort((a,b) => {
      const rank = path => /(?:^|\/)intensity\.(?:jpg|jpeg|png)$/i.test(path) ? 0
        : /(?:^|\/)mmi\.(?:jpg|jpeg|png)$/i.test(path) ? 1
        : /intensity_overlay/i.test(path) ? 2
        : /ii_thumbnail/i.test(path) ? 3 : 4;
      return rank(a[0]) - rank(b[0]);
    });
    let html = '<div style="font-weight:900;font-size:16px;margin-bottom:8px">PETA INTENSITAS GUNCANGAN (MMI)</div>';
    if (mmiCandidates.length) {
      const sourceName = isUsgsEvent ? "USGS ShakeMap" : "USGS ShakeMap (cadangan; peta MMI BMKG tidak tersedia)";
      const urls = mmiCandidates.map(([path,item]) => ({ path, url: item.url }));
      html += '<figure style="margin:0"><img id="wrsMmiFallbackImage" src="' + safe(urls[0].url) + '" alt="Peta intensitas guncangan MMI" loading="eager" style="display:block;width:100%;height:auto;max-height:520px;object-fit:contain;background:#fff;border-radius:8px"></figure>';
      html += '<div style="font-size:11px;line-height:1.45;opacity:.72;margin-top:7px">Sumber peta: ' + sourceName + '. Peta merupakan estimasi ilmiah, bukan pengukuran pasti di setiap lokasi.</div>';
      html += '<div style="font-size:11px;line-height:1.45;opacity:.72">Parameter, status, dan saran untuk gempa global mengikuti metadata USGS; untuk peringatan darurat ikuti otoritas resmi setempat.</div>';
      html += '<a href="' + safe(p.url || ("https://earthquake.usgs.gov/earthquakes/eventpage/" + encodeURIComponent(feature?.id || eventId))) + '" target="_blank" rel="noopener noreferrer" style="font-size:11px;opacity:.7">Sumber resmi peta ↗</a>';
      html += '<script type="application/json" id="wrsMmiFallbackCandidates">' + JSON.stringify(urls).replace(/</g,"\\u003c") + '</script>';
    } else {
      html += '<div style="padding:10px;border:1px solid var(--border,#cbd5e1);border-radius:9px;font-size:13px">Peta intensitas MMI belum tersedia untuk kejadian ini.</div>';
    }
    // Simpan URL gambar MMI yang benar pada data kejadian agar fungsi Simpan/Bagikan
    // dapat memasukkan peta USGS ke kartu PNG, bukan hanya menampilkannya di modal.
    if (mmiCandidates.length) {
      q.exportShakeMapUrl = mmiCandidates[0][1].url;
      q.exportShakeMapSource = "USGS";
      window._modalQuake = q;
    }
    box.innerHTML = html;
    const mmiImage = box.querySelector("#wrsMmiFallbackImage");
    const candidateNode = box.querySelector("#wrsMmiFallbackCandidates");
    if (mmiImage && candidateNode) {
      let candidates = [];
      try { candidates = JSON.parse(candidateNode.textContent || "[]"); } catch {}
      let next = 1;
      mmiImage.onerror = () => {
        if (next < candidates.length) mmiImage.src = candidates[next++].url;
        else {
          mmiImage.style.display = "none";
          const note = document.createElement("div");
          note.style.cssText = "padding:10px;border:1px solid var(--border,#cbd5e1);border-radius:9px;font-size:13px";
          note.textContent = "Gambar peta MMI gagal dimuat. Coba lagi nanti.";
          mmiImage.closest("figure")?.appendChild(note);
        }
      };
    }
  } catch (error) {
    if (window._modalQuake?.key !== q.key) return;
    box.innerHTML = '<div style="font-weight:900;font-size:16px;margin-bottom:8px">PETA INTENSITAS GUNCANGAN (MMI)</div><p style="font-size:13px">Peta MMI belum tersedia atau sumber cadangan sedang tidak dapat diakses.</p>';
    console.warn("Gagal memuat peta MMI cadangan USGS", error);
  }
}

function openModal(q) {
  if (!q) return;
  updateShakeMapLabels(q);
  // Jika potensi tsunami → buka modal tsunami khusus
  if (isTsunamiPotential(q.potential)) {
    openTsunamiModal(q);
    return;
  }

  $("#modalMag").textContent = q.magnitude.toFixed(1);
  $("#modalLabel").textContent = q.magnitude >= 5
    ? "INFO GEMPA BUMI M>5"
    : q.felt ? "INFO GEMPA DIRASAKAN" : "INFO GEMPA";
  $("#modalTime").textContent = "WAKTU GEMPA BUMI: " + fmtTime(q);
  $("#modalSent").textContent = q.timesent
    ? "Waktu pengiriman: " + q.timesent
    : "Waktu pengiriman: " + fmtTime(q);
  $("#modalCoord").textContent = fmtCoord(q);
  $("#modalDepth").textContent = q.depth + " Km";
  $("#modalRegion").textContent = q.place;
  $("#modalSrc").textContent = q.source || "BMKG";

  const isGlobalUsgs = q.source === "USGS" || String(q.key || "").startsWith("usgs|");
  const pot = q.potential && q.potential !== "—"
    ? q.potential
    : isGlobalUsgs
      ? "USGS tidak menandai potensi tsunami pada data event ini; periksa peringatan resmi otoritas setempat."
      : "tidak ada potensi TSUNAMI";
  const tsEl = $("#modalTsunami");
  $("#modalTsunamiText").textContent = pot;
  if (isTsunamiPotential(pot)) tsEl.classList.remove("safe");
  else tsEl.classList.add("safe");

  // Untuk kejadian global, jangan menampilkan saran/status BMKG seolah-olah
  // berasal dari USGS. Status USGS akan diperbarui setelah detail event dimuat.
  const modalInstrHeading = $("#modalInstr b");
  if (modalInstrHeading) modalInstrHeading.textContent = isGlobalUsgs
    ? "Saran keselamatan (USGS):"
    : /INATEWS|WRS/i.test(String(q.source || "")) ? "Informasi dari InaTEWS / WRS:"
    : "Saran dan Instruksi dari BMKG:";
  $("#modalInstrText").textContent = isGlobalUsgs
    ? "Sumber informasi: USGS ComCat. Waspadai gempa susulan dan ikuti arahan otoritas kebencanaan setempat."
    : (q.instruction || "Waspadai kemungkinan gempa susulan. Ikuti informasi dan arahan resmi BMKG.");

  const mmiItems = parseMmi(q.felt);
  const mmiList = $("#modalMmiList");
  if (mmiItems.length) {
    mmiList.innerHTML = mmiItems
      .map((it) => `<div class="mmi-item"><span class="mmi-badge">${it.scale}</span><span>${it.place}</span></div>`)
      .join("");
  } else {
    mmiList.innerHTML = `<div class="mmi-item"><span class="mmi-badge">—</span><span>Belum ada laporan mengenai hal tersebut.</span></div>`;
  }
  $("#modalMmiBox").classList.remove("hidden");

  const smBox = $("#modalShakemapBox");
  const smImg = $("#modalShakemapImg");
  if (q.shakemap) {
    // Utamakan peta MMI BMKG. Jika URL gambar gagal, cari peta MMI USGS
    // untuk kejadian yang sama; jangan menampilkan banyak produk teknis.
    smImg.onload = () => {
      smBox.classList.remove("hidden");
      const fallbackBox = document.getElementById("usgsProductsBox");
      if (fallbackBox) fallbackBox.innerHTML = "";
    };
    smImg.onerror = () => {
      smBox.classList.add("hidden");
      smImg.removeAttribute("src");
      loadUsgsProducts({ ...q, shakemap: "" }, true);
    };
    smImg.src = q.shakemap;
    smBox.classList.remove("hidden");
  } else {
    smBox.classList.add("hidden");
    smImg.removeAttribute("src");
  }

  window._modalQuake = q;
  $("#modalDetail").classList.remove("hidden");
  const fallbackBox = document.getElementById("usgsProductsBox");
  if (!q.shakemap) {
    loadUsgsProducts(q);
  } else if (fallbackBox) {
    fallbackBox.innerHTML = "";
  }
}

function classifyAreaLevel(scale) {
  const s = String(scale || "").toUpperCase();
  if (/VI|VII|VIII|IX|X|XI|XII|AWAS/i.test(s)) return "awas";
  if (/IV|V|SIAGA/i.test(s)) return "siaga";
  return "waspada";
}

function isTsunamiEnded(q) {
  if (q?.ended === true) return true;
  const blob = [q?.headline, q?.description, q?.subject, q?.potential].filter(Boolean).join(" ");
  return /telah\s*berakhir|dinyatakan\s*telah\s*berakhir|all[\s-]?clear|peringatan\s*dicabut/i.test(blob);
}

function openTsunamiModal(q) {
  if (!q) return;
  updateShakeMapLabels(q);
  window._modalQuake = q;
  const mag = Number(q.magnitude);
  $("#tsunamiMag").textContent = Number.isFinite(mag) ? mag.toFixed(1) : "—";
  const when =
    q.date && q.timeLocal
      ? `${q.date} ${q.timeLocal}`
      : fmtTime(q);
  $("#tsunamiTime").textContent = when;
  $("#tsunamiPlace").textContent = q.place || "—";
  $("#tsunamiCoordDepth").textContent = `${fmtCoord(q)} · Kedalaman ${q.depth} km`;
  $("#tsunamiSrc").textContent = q.source || "InaTEWS / BMKG";

  const subject = q.subject || "";
  const pot =
    q.potential && q.potential !== "—"
      ? q.potential
      : subject || "Berpotensi tsunami — pantau informasi resmi BMKG";
  const pd =
    q.pd ||
    (subject.match(/PD[-\s]?([\d.]+)/i) || [])[1] ||
    "";
  const ended = isTsunamiEnded(q);

  $("#tsunamiTitle").textContent = pd
    ? `WARNING TSUNAMI PD-${pd}`
    : /awas/i.test(pot)
    ? "PERINGATAN TSUNAMI — AWAS"
    : "PERINGATAN TSUNAMI";
  // Subtitle = status berakhir / masih aktif (bukan ulang judul)
  $("#tsunamiSubtitle").textContent = ended
    ? "✅ Status: Dinyatakan TELAH BERAKHIR oleh BMKG/InaTEWS"
    : "⚠️ Status: MASIH AKTIF / pantau terus informasi resmi BMKG";

  $("#tsunamiPotText").textContent = q.headline || pot;

  const card = $("#tsunamiCard");
  const header = card?.querySelector(".tsunami-header");
  if (card) {
    card.classList.toggle("tsunami-ended", ended);
    card.classList.toggle("tsunami-active", !ended);
  }
  if (header) {
    header.style.background = ended
      ? "linear-gradient(90deg,#14532d,#15803d 40%,#166534)"
      : "";
  }

  const instrParts = [
    q.instruction,
    q.instruction1,
    q.instruction2,
    q.instruction3,
  ].filter(Boolean);
  $("#tsunamiInstrText").textContent =
    instrParts.join(" ") ||
    "Segera menjauh dari pantai, muara, dan daerah rawan tsunami. Ikuti arahan petugas setempat. Pantau informasi resmi BMKG/InaTEWS.";

  const mmiItems = parseMmi(q.felt);
  const list = $("#tsunamiAreaList");
  if (mmiItems.length) {
    list.innerHTML = mmiItems
      .map((it) => {
        const lvl = classifyAreaLevel(it.scale);
        const label = lvl === "awas" ? "AWAS" : lvl === "siaga" ? "SIAGA" : "WASPADA";
        return `<div class="tsunami-area-item"><span class="badge badge-${lvl}">${label}</span><span>${it.scale !== "—" ? it.scale + " · " : ""}${it.place}</span></div>`;
      })
      .join("");
  } else if (q.description) {
    list.innerHTML = `<div class="tsunami-area-item"><span class="badge ${ended ? "badge-waspada" : "badge-siaga"}">${ended ? "BERAKHIR" : "INFO"}</span><span>${q.description.slice(0, 280)}${q.description.length > 280 ? "…" : ""}</span></div>`;
  } else {
    list.innerHTML = `<div class="tsunami-area-item"><span class="badge badge-waspada">WASPADA</span><span>${q.place || "Wilayah sekitar pusat gempa"} — pantau info resmi</span></div>`;
  }

  // Pastikan URL peta pakai GCS (bukan data.bmkg yang 403)
  const fixUrl = (u) => {
    if (!u) return null;
    return String(u).replace(
      /^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i,
      SHAKEMAP_BASE
    );
  };

  const setMap = (boxId, imgId, url, label) => {
    const box = $(boxId);
    const img = $(imgId);
    if (!box || !img) return;
    const u = fixUrl(url);
    if (u) {
      img.onload = () => { box.style.display = ""; };
      img.onerror = () => { box.style.display = "none"; };
      img.src = u;
      img.alt = label || "";
      box.style.display = "";
    } else {
      box.style.display = "none";
      img.removeAttribute("src");
    }
  };
  setMap("#tsunamiShakemapBox", "#tsunamiShakemapImg", q.shakemap, "ShakeMap");
  setMap("#tsunamiSshBox", "#tsunamiSshImg", q.sshmap, "SSHmax");
  setMap("#tsunamiWzBox", "#tsunamiWzImg", q.wzmap, "Warning Zone");
  setMap("#tsunamiTtBox", "#tsunamiTtImg", q.ttmap, "Travel Time");

  renderTsunamiZoneTable(q);

  $("#modalDetail").classList.add("hidden");
  $("#modalTsunamiAlert").classList.remove("hidden");
}

function closeTsunamiModal() {
  $("#modalTsunamiAlert")?.classList.add("hidden");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updatePopupDistance(q) {
  const distEl = $("#popDistance");
  const locEl = $("#popUserLocation");
  if (!distEl || !locEl) return;
  if (userLocation && Number.isFinite(q.lat) && Number.isFinite(q.lon)) {
    const km = haversineKm(userLocation.lat, userLocation.lon, q.lat, q.lon);
    distEl.textContent = `📍 Jarak dari lokasi Anda: ${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("id-ID")} km`;
    locEl.textContent = `Lokasi Anda: ${userLocation.lat.toFixed(4)}°, ${userLocation.lon.toFixed(4)}°`;
  } else {
    distEl.textContent = "📍 Jarak dari lokasi Anda: belum tersedia";
    locEl.textContent = "Aktifkan izin lokasi untuk menghitung jarak dari perangkat";
  }
}

function setLocStatus(ok, text) {
  const el = $("#locStatus");
  if (el) el.textContent = text;
  const btn = $("#btnLocation");
  if (btn) btn.classList.toggle("on", !!ok);
  const tb = $("#tbLocation");
  if (tb) tb.dataset.on = ok ? "1" : "0";
}

function updateUserMarker(fly) {
  if (!map || !userLocation) return;
  const latlng = [userLocation.lat, userLocation.lon];
  if (!userMarker) {
    userMarker = L.marker(latlng, {
      icon: L.divIcon({
        className: "user-loc-marker",
        html: '<div class="user-pin"><span class="user-pin-dot"></span><span class="user-pin-ring"></span></div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      zIndexOffset: 2000,
      title: "Lokasi Anda",
    }).addTo(map);
    userMarker.bindTooltip("📍 Lokasi Anda", { direction: "top", opacity: 0.95 });
  } else {
    userMarker.setLatLng(latlng);
  }
  if (fly) map.flyTo(latlng, Math.max(map.getZoom(), 8), { duration: 0.7 });
  updateRealtimeDistance();
}

function updateRealtimeDistance() {
  const el = $("#rtDist");
  if (!el) return;
  const q = primaryRealtimeQuake();
  if (userLocation && q && Number.isFinite(q.lat) && Number.isFinite(q.lon)) {
    const km = haversineKm(userLocation.lat, userLocation.lon, q.lat, q.lon);
    const dist =
      km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("id-ID");
    el.textContent = `📍 Jarak ke Anda: ${dist} km · Anda ${userLocation.lat.toFixed(3)}°, ${userLocation.lon.toFixed(3)}°`;
    el.classList.add("has-loc");
  } else if (userLocation) {
    el.textContent = `📍 Lokasi Anda: ${userLocation.lat.toFixed(3)}°, ${userLocation.lon.toFixed(3)}°`;
    el.classList.add("has-loc");
  } else {
    el.textContent = "📍 Jarak ke Anda: aktifkan lokasi";
    el.classList.remove("has-loc");
  }
}

function activateLocation(showAlert) {
  // Jika sudah punya lokasi → fokus ke pin di peta
  if (userLocation && map) {
    updateUserMarker(true);
    setLocStatus(true, `Lokasi · ${userLocation.lat.toFixed(3)}°, ${userLocation.lon.toFixed(3)}°`);
    if (window._modalQuake) updatePopupDistance(window._modalQuake);
    const primary = primaryRealtimeQuake();
    if (primary) updatePopupDistance(primary);
    return;
  }
  if (!navigator.geolocation) {
    setLocStatus(false, "Lokasi · browser tidak mendukung");
    if (showAlert) alert("Browser tidak mendukung lokasi.");
    return;
  }
  setLocStatus(false, "Lokasi · meminta izin…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      locationAttempted = true;
      try {
        localStorage.setItem("wrsUserLoc", JSON.stringify(userLocation));
      } catch {}
      setLocStatus(true, `Lokasi · ${userLocation.lat.toFixed(3)}°, ${userLocation.lon.toFixed(3)}°`);
      updateUserMarker(true);
      if (window._modalQuake) updatePopupDistance(window._modalQuake);
      const pop = $("#popupNew");
      if (pop && !pop.classList.contains("hidden") && quakes[0]) updatePopupDistance(quakes[0]);
    },
    (err) => {
      locationAttempted = true;
      const msg =
        err?.code === 1
          ? "Lokasi · izin ditolak"
          : err?.code === 2
          ? "Lokasi · GPS tidak tersedia"
          : "Lokasi · gagal";
      setLocStatus(false, msg);
      if (showAlert) alert(msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function requestUserLocation(q) {
  updatePopupDistance(q);
  if (userLocation) return;
  // Restore cached
  try {
    const cached = JSON.parse(localStorage.getItem("wrsUserLoc") || "null");
    if (cached?.lat) {
      userLocation = cached;
      setLocStatus(true, `Lokasi (cache): ${cached.lat.toFixed(4)}°, ${cached.lon.toFixed(4)}°`);
      updatePopupDistance(q);
      return;
    }
  } catch {}
  if (locationAttempted || !navigator.geolocation) return;
  activateLocation(false);
}

function showPopup(q) {
  $("#popMag").textContent = "M" + q.magnitude.toFixed(1);
  $("#popPlace").textContent = q.place;
  $("#popMeta").textContent = fmtTime(q) + " · " + fmtCoord(q) + " · " + q.depth + " km";
  requestUserLocation(q);
  $("#popupNew").classList.remove("hidden");
  clearTimeout(popupTimer);
  popupTimer = setTimeout(() => {
    $("#popupNew").classList.add("hidden");
    renderRealtime(q);
  }, 10000);
}

/* ---------- Audio: bel sekolah + TTS lengkap ---------- */
function ensureAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      return audioCtx.resume().then(() => audioCtx).catch(() => audioCtx);
    }
    return Promise.resolve(audioCtx);
  } catch (e) {
    console.warn("AudioContext gagal:", e);
    return Promise.reject(e);
  }
}

/** Nada tunggal bel (oscilator + envelope) */
function tone(ctx, freq, t0, dur, vol, type) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type || "sine";
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(vol * 0.7, t0 + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

/**
 * Bel sekolah: nada rendah → tinggi (mirip bel sekolah klasik),
 * lalu bel penutup setelah TTS.
 * mode: 'normal' | 'alert' (M≥5) | 'tsunami'
 */
function playSchoolBell(mode) {
  return ensureAudio().then((ctx) => {
    if (!ctx) return 0;
    const now = ctx.currentTime;
    const isAlert = mode === "alert" || mode === "tsunami";
    const isTsunami = mode === "tsunami";
    const vol = isTsunami ? 0.42 : isAlert ? 0.36 : 0.28;

    // Pola bel sekolah: do-re-mi naik (rendah → tinggi), 2x
    // C4 D4 E4 G4  lalu  C5 E5 G5
    const pattern = isTsunami
      ? [
          { f: 392, d: 0.22 }, { f: 494, d: 0.22 }, { f: 587, d: 0.22 }, { f: 784, d: 0.35 },
          { f: 0, d: 0.12 },
          { f: 523, d: 0.18 }, { f: 659, d: 0.18 }, { f: 784, d: 0.18 }, { f: 1047, d: 0.4 },
        ]
      : isAlert
      ? [
          { f: 349, d: 0.2 }, { f: 440, d: 0.2 }, { f: 523, d: 0.2 }, { f: 698, d: 0.32 },
          { f: 0, d: 0.1 },
          { f: 440, d: 0.16 }, { f: 554, d: 0.16 }, { f: 659, d: 0.28 },
        ]
      : [
          { f: 330, d: 0.18 }, { f: 392, d: 0.18 }, { f: 494, d: 0.18 }, { f: 587, d: 0.28 },
          { f: 0, d: 0.08 },
          { f: 392, d: 0.15 }, { f: 494, d: 0.15 }, { f: 587, d: 0.25 },
        ];

    let t = now;
    pattern.forEach((p) => {
      if (p.f > 0) {
        tone(ctx, p.f, t, p.d, vol, isTsunami ? "square" : "sine");
        // Harmonic ringan agar lebih "metallic" seperti bel
        tone(ctx, p.f * 2.01, t, p.d * 0.7, vol * 0.18, "sine");
      }
      t += p.d + 0.02;
    });
    return (t - now) * 1000; // durasi ms
  }).catch(() => 0);
}

/** Bel penutup singkat */
function playBellClose(mode) {
  return ensureAudio().then((ctx) => {
    if (!ctx) return;
    const now = ctx.currentTime;
    const isAlert = mode === "alert" || mode === "tsunami";
    const vol = isAlert ? 0.3 : 0.22;
    // Naik singkat lalu turun
    tone(ctx, 523, now, 0.2, vol, "sine");
    tone(ctx, 659, now + 0.18, 0.22, vol * 0.9, "sine");
    tone(ctx, 784, now + 0.36, 0.35, vol, "sine");
    tone(ctx, 1568, now + 0.36, 0.25, vol * 0.15, "sine");
  }).catch(() => {});
}

function getIdVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /id/i.test(v.lang)) || voices.find((v) => /indonesia/i.test(v.name)) || null;
}

/**
 * TTS lengkap:
 * "Mohon perhatian. Telah terjadi gempa terbaru magnitudo X,
 *  kedalaman Y kilometer, di wilayah Z. Terima kasih."
 * Versi lebih tegas untuk M≥5 / tsunami.
 */
function speakFull(q, mode) {
  if (!$("#optVoice")?.checked || !("speechSynthesis" in window)) return Promise.resolve();
  speechSynthesis.cancel();

  const mag = q.magnitude.toFixed(1).replace(".", ",");
  const depth = q.depth;
  const place = (q.place || "Indonesia").replace(/,/g, " ");
  let text;
  if (mode === "tsunami") {
    text = `Mohon perhatian. Peringatan tsunami. Telah terjadi gempa magnitudo ${mag}, kedalaman ${depth} kilometer, di wilayah ${place}. Terdapat potensi tsunami. Segera menjauh dari pantai dan ikuti arahan petugas. Terima kasih.`;
  } else if (mode === "alert") {
    text = `Mohon perhatian. Alert gempa magnitudo ${mag}. Kedalaman ${depth} kilometer. Wilayah ${place}. Harap waspada terhadap gempa susulan. Terima kasih.`;
  } else {
    text = `Mohon perhatian. Telah terjadi gempa terbaru magnitudo ${mag}, kedalaman ${depth} kilometer, di wilayah ${place}. Terima kasih.`;
  }

  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "id-ID";
    u.rate = mode === "tsunami" ? 0.95 : 1.0;
    u.volume = 1;
    u.pitch = mode === "tsunami" ? 1.05 : 1;
    const idv = getIdVoice();
    if (idv) u.voice = idv;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
    // Fallback timeout jika onend tidak terpanggil
    setTimeout(resolve, Math.min(22000, text.length * 80 + 2000));
  });
}

/** Sequence: bel sekolah → TTS → bel penutup */
async function playAlarmSequence(q) {
  const pot = q.potential || "";
  const isTs = isTsunamiPotential(pot);
  const mode = isTs ? "tsunami" : q.magnitude >= 5 ? "alert" : "normal";

  if ($("#optBell")?.checked) {
    const waitMs = await playSchoolBell(mode);
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 600) + 150));
  }
  if ($("#optVoice")?.checked) {
    await speakFull(q, mode);
    await new Promise((r) => setTimeout(r, 200));
  }
  if ($("#optBell")?.checked) {
    playBellClose(mode);
  }
}

function processNew() {
  if (firstLoad) {
    quakes.forEach((q) => {
      seen.add(q.key);
      const id = stableEventId(q);
      if (id) paramCache[id] = snapshotParams(q);
    });
    realtimeEvents.forEach((q) => {
      const id = stableEventId(q);
      if (id) paramCache[id] = snapshotParams(q);
    });
    localStorage.setItem("wrsSeenV8", JSON.stringify([...seen].slice(-1000)));
    saveParamCache();
    firstLoad = false;
    return;
  }

  // Deteksi pemutakhiran pada SEMUA event di feed realtime InaTEWS/WRS,
  // bukan hanya event teratas. Identitas stabil mencegah revisi dianggap gempa baru.
  const revisionCandidates = realtimeEvents.length ? realtimeEvents : [primaryRealtimeQuake()].filter(Boolean);
  const revisions = [];
  for (const event of revisionCandidates) {
    const rev = detectRevision(event);
    if (rev) {
      rev.place = event.place || "";
      revisions.push(rev);
    }
  }
  if (revisions.length) {
    // Simpan dan tampilkan SEMUA revisi yang terdeteksi pada siklus polling ini.
    revisions.sort((a,b) => Number(b.significant)-Number(a.significant));
    revisions.forEach(rev => showRealtimeUpdate(rev, true));
    const rev = revisions.find(item => item.significant) || revisions[0];
    const primary = primaryRealtimeQuake();
    if (primary) renderRealtime(primary);
    saveParamCache();

    if (rev.significant && alarmOn) {
      ensureAudio()
        .then(async () => {
          if ($("#optBell")?.checked) {
            await playSchoolBell(rev.next.magnitude >= 5 ? "alert" : "normal");
            await new Promise((r) => setTimeout(r, 400));
          }
          if ($("#optVoice")?.checked && "speechSynthesis" in window) {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(
              `Pemutakhiran parameter gempa di ${rev.place || "wilayah terdeteksi"}. Magnitudo sekarang ${rev.next.magnitude.toFixed(1).replace(".", ",")}, kedalaman ${rev.next.depth} kilometer.`
            );
            u.lang = "id-ID";
            u.rate = 1;
            const idv = getIdVoice();
            if (idv) u.voice = idv;
            speechSynthesis.speak(u);
          }
        })
        .catch(() => {});
    }
  } else {
    saveParamCache();
  }

  // Seed cache untuk event lain (tanpa notif)
  quakes.slice(0, 80).forEach((q) => {
    const id = stableEventId(q);
    if (id && !paramCache[id]) paramCache[id] = snapshotParams(q);
  });
  realtimeEvents.forEach((q) => {
    const id = stableEventId(q);
    if (id && !paramCache[id]) paramCache[id] = snapshotParams(q);
  });

  const fresh = quakes.filter((q) => !seen.has(q.key));
  quakes.forEach((q) => seen.add(q.key));
  localStorage.setItem("wrsSeenV8", JSON.stringify([...seen].slice(-1000)));
  if (!fresh.length) return;

  const q = fresh.sort((a, b) => new Date(a.time) - new Date(b.time)).at(-1);
  // Isi cache event baru
  const sid = stableEventId(q);
  if (sid) {
    paramCache[sid] = snapshotParams(q);
    saveParamCache();
  }
  showPopup(q);
  if (Number.isFinite(q.lat) && Number.isFinite(q.lon)) {
    map.flyTo([q.lat, q.lon], 7, { duration: 0.8 });
    const highlight = L.circleMarker([q.lat, q.lon], {
      radius: 20, color: "#ffffff", weight: 3, fillColor: "#22d3ee", fillOpacity: 0.16,
      className: "quake-new-event-highlight"
    }).addTo(map);
    setTimeout(() => { try { map.removeLayer(highlight); } catch {} }, 10000);
  }

  if (isTsunamiPotential(q.potential)) {
    openTsunamiModal(q);
  }

  if (alarmOn) {
    ensureAudio().then(() => playAlarmSequence(q)).catch(() => {});
  }
}

function status(ok, text) {
  const dot = $("#liveDot");
  const label = $("#liveText");
  if (dot) dot.className = ok ? "ok" : "bad";
  if (label) label.textContent = text;
}

const WRS_TEST_SCENARIOS = [
  { id: "lombok", lat: -8.5, lon: 116.1, place: "Lombok, Nusa Tenggara Barat", depth: 10 },
  { id: "sulawesi", lat: -1.2, lon: 120.0, place: "Sulawesi Tengah", depth: 18 },
  { id: "sumatra", lat: -2.1, lon: 100.2, place: "Barat Daya Sumatra", depth: 25 },
  { id: "ntt", lat: -9.2, lon: 119.8, place: "Laut selatan Nusa Tenggara Timur", depth: 20 },
  { id: "maluku", lat: -2.8, lon: 129.5, place: "Laut Seram, Maluku", depth: 15 },
  { id: "jawa", lat: -10.0, lon: 110.0, place: "Samudra Hindia selatan Jawa", depth: 22 }
];
let simulationScenarioIndex = 1;
let simulationTestLog = [];
let simulationSequence = [];
let simulationSequenceIndex = 0;
let simulationSequenceActive = false;
let simulationSequencePaused = false;
let simulationSequenceRepeat = false;
let simulationSequenceTimer = null;

function simulationMapSvg(kind, magnitude) {
  const isShake = kind === "shake";
  const title = isShake ? "SHAKEMAP MMI · SIMULASI" : kind === "ssh" ? "TINGGI MUKA LAUT · SIMULASI" : kind === "warning" ? "ZONA PERINGATAN · SIMULASI" : "WAKTU TIBA · SIMULASI";
  const colors = isShake ? ["#fff7bc","#fec44f","#fe9929","#ec7014","#cc4c02"] : ["#dbeafe","#93c5fd","#60a5fa","#2563eb","#1e3a8a"];
  const rings = [150,120,92,65,38].map((r,i)=>'<ellipse cx="180" cy="120" rx="'+r+'" ry="'+Math.round(r*.63)+'" fill="'+colors[i]+'" fill-opacity=".72" stroke="#fff" stroke-opacity=".75" stroke-width="1.5"/>').join("");
  const extra = isShake
    ? '<text x="18" y="214" fill="#e2e8f0" font-size="10">Intensitas MMI: ilustrasi model, bukan hasil sensor</text>'
    : '<path d="M0 176 Q55 158 102 176 T205 176 T360 176 V240 H0Z" fill="#38bdf8" fill-opacity=".18"/><text x="18" y="214" fill="#e2e8f0" font-size="10">Tidak ada estimasi resmi ETA/tinggi gelombang</text>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240"><rect width="360" height="240" fill="#0b1729"/><path d="M0 40H360M0 80H360M0 120H360M0 160H360M0 200H360M60 0V240M120 0V240M180 0V240M240 0V240M300 0V240" stroke="#64748b" stroke-opacity=".22"/><text x="14" y="22" fill="#f8fafc" font-size="12" font-weight="700">'+title+'</text>'+rings+'<circle cx="180" cy="120" r="5" fill="#fff" stroke="#111827" stroke-width="2"/><text x="191" y="114" fill="#fff" font-size="10">Episenter uji</text>'+extra+'<text x="14" y="234" fill="#fbbf24" font-size="10" font-weight="700">DATA FIKTIF UNTUK PENGUJIAN · M'+Number(magnitude).toFixed(1)+'</text></svg>';
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* Tsunami simulation stages. All heights and colored zones here are fictitious training data. */
let simulationTsunamiStageIndex = -1;
const SIMULATION_COASTS = {
  lombok:[["Ampenan",-8.57,116.07,.35],["Tanjung",-8.36,116.16,.65],["Labuhan Lombok",-8.49,116.67,1.1],["Senggigi",-8.49,116.04,.45]],
  sulawesi:[["Palu",-.89,119.87,1.4],["Donggala",-.67,119.74,1.8],["Parigi",-.82,120.17,.75],["Toli-Toli",1.04,120.81,.4]],
  sumatra:[["Padang",-.95,100.36,1.7],["Mentawai",-1.5,99,2.2],["Painan",-1.35,100.57,1.1],["Bengkulu",-3.8,102.26,.55]],
  ntt:[["Maumere",-8.62,122.21,1.1],["Ende",-8.84,121.65,.8],["Larantuka",-8.35,122.98,1.45],["Kupang",-10.17,123.61,.45]],
  maluku:[["Ambon",-3.7,128.18,.75],["Masohi",-3.3,128.92,1.3],["Buru",-3.38,126.78,.6],["Banda",-4.52,129.9,1.6]],
  jawa:[["Pangandaran",-7.7,108.65,1.5],["Cilacap",-7.73,109.01,1.1],["Pacitan",-8.2,111.1,1.8],["Banyuwangi selatan",-8.6,114.35,.7]]
};
const SIMULATION_TSUNAMI_STAGES = [
 {pd:"PD-1",title:"Peringatan awal",level:"waspada",multiplier:.45,description:"Potensi tsunami sedang dikaji; wilayah terdampak belum final."},
 {pd:"PD-2",title:"Daftar wilayah awal",level:"siaga",multiplier:.7,description:"Daftar wilayah dan estimasi tinggi simulasi mulai ditampilkan."},
 {pd:"PD-3.1",title:"Pemutakhiran 1",level:"siaga",multiplier:.85,description:"Pembaruan model latihan; cakupan dapat berubah."},
 {pd:"PD-3.2",title:"Pemutakhiran 2",level:"siaga",multiplier:1,description:"Pembaruan kedua dengan daftar tinggi simulasi."},
 {pd:"PD-3.3",title:"Pemutakhiran 3",level:"awas",multiplier:1.15,description:"Skenario latihan menunjukkan ancaman lebih tinggi di beberapa titik."},
 {pd:"PD-3.4",title:"Pemutakhiran 4",level:"awas",multiplier:.9,description:"Model latihan diperbarui kembali."},
 {pd:"PD-4",title:"Buletin akhir latihan",level:"siaga",multiplier:.5,description:"Buletin akhir skenario; bukan berarti ancaman otomatis berakhir."},
 {pd:"BERAKHIR",title:"TSUNAMI TELAH BERAKHIR",level:"ended",multiplier:0,description:"Tahap hijau: peringatan latihan dinyatakan berakhir."}
];
function tsunamiLevelForHeight(h){return h>3?{label:"AWAS",color:"#ef4444"}:h>=.5?{label:"SIAGA",color:"#f97316"}:{label:"WASPADA",color:"#eab308"}}
function clearTsunamiMapLayer(){if(tsunamiMapLayer)tsunamiMapLayer.clearLayers()}
function renderSimulationTsunamiMap(q,index){
 // Jangan gambar lingkaran/area genangan buatan di peta utama.
 // Visualisasi latihan tetap ada pada panel tahap PD; peta utama disisakan
 // untuk titik gempa asli yang bisa diklik dan dibuka detailnya.
 if(!map||!tsunamiMapLayer)return;
 clearTsunamiMapLayer();
}
function renderTsunamiStagePanel(index,q){
 const box=document.querySelector("#wrsTsunamiStage");if(!box)return;
 if(wrsMode!=="simulation"||!q?.simulation||!q?.isTsunamiWarning||index<0){box.hidden=true;box.innerHTML="";return}
 const stage=SIMULATION_TSUNAMI_STAGES[Math.min(index,SIMULATION_TSUNAMI_STAGES.length-1)],ended=stage.level==="ended";
 const loc=document.querySelector("#wrsTestLocation")?.value||"sulawesi";
 const rows=ended?"":(SIMULATION_COASTS[loc]||SIMULATION_COASTS.sulawesi).map(area=>{
  const h=Math.max(.05,area[3]*stage.multiplier),level=tsunamiLevelForHeight(h);
  return '<div class="wrs-tsunami-zone-row"><b style="color:'+level.color+'">'+level.label+'</b><span>'+area[0]+'</span><strong>'+h.toFixed(2)+' m</strong></div>';
 }).join("");
 box.hidden=false;
 box.innerHTML='<div class="wrs-tsunami-stage-head '+(ended?"ended":"")+'"><span class="wrs-tsunami-stage-chip">'+(ended?"✓ BERAKHIR":stage.pd)+'</span><div><strong>'+stage.title+'</strong><small>'+stage.description+'</small></div></div>'+
 (ended?'<div class="wrs-tsunami-ended-note">Peringatan latihan berakhir · status hijau. Hanya berlaku pada simulasi lokal.</div>':
 '<div class="wrs-tsunami-warning-note">SIMULASI LOKAL · BUKAN PERINGATAN RESMI. Tinggi di bawah adalah angka latihan.</div><div class="wrs-tsunami-zone-list">'+rows+'</div>');
}
function clearSimulationTsunamiStage(){simulationTsunamiStageIndex=-1;renderSimulationTsunamiMap(null,-1);renderTsunamiStagePanel(-1,null)}


function safeTsunamiMapText(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function safeTsunamiAssetUrl(value){
 if(!value)return "";
 let u;
 try{u=new URL(String(value).replace(/^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i, SHAKEMAP_BASE));}catch{return ""}
 if(u.protocol!=="https:")return "";
 if(!/(^|\.)bmkg-content-inatews\.storage\.googleapis\.com$|(^|\.)storage\.googleapis\.com$|(^|\.)cdn\.bmkg\.go\.id$/.test(u.hostname))return "";
 return u.href;
}
function tsunamiBulletinTime(q){
 const raw=q?.timesent||q?.time||"";
 const parsed=Date.parse(raw);
 return Number.isFinite(parsed)?parsed:0;
}
/** Observasi tinggi muka laut hanya diplot bila buletin menyertakan koordinat eksplisit. */
function parseTsunamiObservations(q){
 const raw=[q?.description,q?.headline,q?.subject].filter(Boolean).join("\n")
  .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/tr>/gi,"\n").replace(/<\/t[dh]>/gi," | ").replace(/&nbsp;/gi," ");
 const locRe=/([A-Z][A-Z0-9 _.,()/-]{2,70}?)\s*\(\s*(-?\d{1,2}(?:[.,]\d+)?)\s+(-?\d{1,3}(?:[.,]\d+)?)\s*\)/gi;
 const locs=[...raw.matchAll(locRe)],out=[],seen=new Set();
 locs.forEach((m,index)=>{
  const lat=Number(m[2].replace(",", ".")),lon=Number(m[3].replace(",", "."));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;
  const next=locs[index+1];
  const tail=raw.slice(m.index+m[0].length,next?next.index:Math.min(raw.length,m.index+m[0].length+260));
  const hm=tail.match(/(?:^|[|;\s])([0-9]+(?:[.,][0-9]+)?)\s*m(?:\b|$)/i);
  if(!hm)return;
  const height=Number(hm[1].replace(",", "."));
  if(!Number.isFinite(height)||height<0)return;
  const name=m[1].replace(/[|;,]+$/,"").trim();
  const time=tail.match(/(\d{2}[-/]\d{2}[-/]\d{4}[^|;\n]*?\d{2}:\d{2}(?::\d{2})?\s*(?:WIB|WITA|WIT)?|\d{1,2}:\d{2}\s*(?:WIB|WITA|WIT))/i)?.[1]||"Waktu observasi tidak tersedia";
  const key=[name,lat.toFixed(3),lon.toFixed(3),height].join("|");
  if(seen.has(key))return;seen.add(key);
  out.push({name,lat,lon,height,time});
 });
 return out;
}
/** Baca tabel provinsi/kabupaten/status/ETA bila format tabel ada di CAP. */
function parseTsunamiWarningAreas(q){
 const raw=[q?.description,q?.instruction,q?.instruction1,q?.instruction2,q?.instruction3].filter(Boolean).join("\n")
  .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/tr>/gi,"\n").replace(/<\/t[dh]>/gi," | ").replace(/&nbsp;/gi," ");
 const out=[],seen=new Set();
 const add=(province,area,status,eta)=>{
  province=String(province||"").trim();area=String(area||"").trim();status=String(status||"").toUpperCase().trim();eta=String(eta||"").trim();
  if(!area||!/(AWAS|SIAGA|WASPADA)/.test(status)||/^(PROVINSI|KOTA.?KABUPATEN|STATUS|ESTIMASI TIBA)$/i.test(area))return;
  const key=[province,area,status,eta].join("|");if(seen.has(key))return;seen.add(key);out.push({province,area,status,eta});
 };
 const pipeRe=/([^|\n]{2,40})\s*\|\s*([^|\n]{2,70})\s*\|\s*(AWAS|SIAGA|WASPADA)\s*\|\s*([^|\n]{2,70})/gi;
 for(const m of raw.matchAll(pipeRe))add(m[1],m[2],m[3],m[4]);
 for(const line of raw.split(/\n/).map(x=>x.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim()).filter(Boolean)){
  const parts=line.split("|").map(x=>x.trim()).filter(Boolean);
  if(parts.length>=4){const si=parts.findIndex(x=>/^(AWAS|SIAGA|WASPADA)\b/i.test(x));if(si>=1)add(parts[0],parts[1],parts[si],parts.slice(si+1).join(" | "));}
 }
 return out;
}
let tsunamiMapControl=null,tsunamiMapControlNode=null;
function ensureTsunamiMapControl(){
 if(!map||tsunamiMapControl)return;
 tsunamiMapControl=L.control({position:"topright"});
 tsunamiMapControl.onAdd=()=>{
  const el=L.DomUtil.create("div","wrs-tsunami-map-control");
  el.setAttribute("aria-label","Informasi tsunami resmi");
  L.DomEvent.disableClickPropagation(el);L.DomEvent.disableScrollPropagation(el);
  tsunamiMapControlNode=el;return el;
 };
 tsunamiMapControl.addTo(map);
}
function formatTsunamiBulletinTime(q){
 const raw=q?.timesent||q?.time||"";
 const d=new Date(raw);
 if(Number.isNaN(d.getTime()))return "Waktu kirim tidak tersedia";
 return new Intl.DateTimeFormat("id-ID",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"Asia/Jakarta"}).format(d)+" WIB";
}
function renderTsunamiMapControl(latestEvents,allEvents){
 ensureTsunamiMapControl();
 const el=tsunamiMapControlNode;if(!el)return;
 if(!latestEvents.length){el.style.display="none";el.innerHTML="";return}
 const rows=latestEvents.slice(0,4).map(q=>{
  const ended=isTsunamiEnded(q),age=Date.now()-tsunamiBulletinTime(q),stale=!ended&&age>6*3600000;
  const label=ended?"BERAKHIR":stale?"PERLU VERIFIKASI":"BUletin terbaru";
  const color=ended?"#22c55e":stale?"#94a3b8":"#f97316";
  return '<div class="wrs-tsu-map-event"><i style="background:'+color+'"></i><span><b>'+safeTsunamiMapText(q.pd?"PD-"+q.pd:"TSUNAMI")+'</b><small>'+safeTsunamiMapText(q.place||"Lokasi gempa")+' · '+safeTsunamiMapText(label)+'</small><small>'+safeTsunamiMapText(formatTsunamiBulletinTime(q))+'</small></span></div>';
 }).join("");
 const latest=latestEvents[0];
 const latestEventId=String(latest?.eventid||latest?.key||latest?.place||"");
 const timeline=(Array.isArray(allEvents)?allEvents:[]).filter(q=>String(q?.eventid||q?.key||q?.place||"")===latestEventId)
  .sort((a,b)=>tsunamiBulletinTime(a)-tsunamiBulletinTime(b)).slice(-6);
 const timelineHtml=timeline.length?'<div class="wrs-tsu-map-section"><b>Timeline buletin terbaru</b>'+timeline.map(q=>{
  const ended=isTsunamiEnded(q),label=ended?"BERAKHIR":(q.pd?"PD-"+q.pd:"Peringatan");
  return '<div class="wrs-tsu-map-timeline"><span>'+safeTsunamiMapText(label)+'</span><small>'+safeTsunamiMapText(formatTsunamiBulletinTime(q))+'</small></div>';
 }).join("")+'</div>':'';
 const observations=latestEvents.slice(0,6).flatMap(parseTsunamiObservations).slice(0,6);
 const areas=latestEvents.slice(0,4).flatMap(parseTsunamiWarningAreas).slice(0,8);
 const assets=[["SSHmax",safeTsunamiAssetUrl(latest.sshmap)],["Warning Zone",safeTsunamiAssetUrl(latest.wzmap)],["Waktu tiba",safeTsunamiAssetUrl(latest.ttmap)]].filter(x=>x[1]);
 const assetHtml=assets.length?'<div class="wrs-tsu-map-products">'+assets.map(([label,url])=>'<a href="'+safeTsunamiMapText(url)+'" target="_blank" rel="noopener"><img loading="lazy" src="'+safeTsunamiMapText(url)+'" alt="'+label+'"><span>'+label+' ↗</span></a>').join("")+'</div>':'';
 const areaHtml=areas.length?'<div class="wrs-tsu-map-section"><b>Zona peringatan dari buletin</b>'+areas.map(a=>'<div class="wrs-tsu-map-area"><span class="wrs-tsu-status '+a.status.toLowerCase()+'">'+a.status+'</span><span>'+safeTsunamiMapText(a.area)+'</span><small>'+safeTsunamiMapText(a.eta||"ETA tidak tercantum")+'</small></div>').join("")+'</div>':'';
 const obsHtml=observations.length?'<div class="wrs-tsu-map-section"><b>Observasi muka laut</b>'+observations.map(o=>'<div class="wrs-tsu-map-area"><span class="wrs-tsu-height-dot" style="background:'+(o.height>=1?"#dc2626":o.height>=.3?"#f97316":"#eab308")+'"></span><span>'+safeTsunamiMapText(o.name)+'</span><strong>'+o.height.toFixed(2)+' m</strong></div>').join("")+'</div>':'';
 el.style.display="block";
 el.innerHTML='<div class="wrs-tsu-map-title">TSUNAMI · InaTEWS</div><div class="wrs-tsu-map-events">'+rows+'</div>'+timelineHtml+areaHtml+obsHtml+assetHtml+
 '<div class="wrs-tsu-map-note">Titik berwarna = observasi dengan koordinat eksplisit. Produk Warning Zone/SSHmax adalah pratinjau resmi, bukan overlay geografis karena batas koordinat raster belum tersedia.</div>';
}
function removeTsunamiMapControl(){
  // Buletin tidak ditempel sebagai tabel di atas peta operasional.
  // Detail dan riwayat tetap tersedia lewat panel/modal tsunami yang sudah ada.
  if(tsunamiMapControl&&map){
   try{map.removeControl(tsunamiMapControl);}catch(_){}
  }
  tsunamiMapControl=null;
  tsunamiMapControlNode=null;
}
function renderOfficialTsunamiMap(){
  if(!map||!tsunamiMapLayer)return;
  // The quake marker group is separate and is never cleared or recreated here.
  clearTsunamiMapLayer();
  removeTsunamiMapControl();
  if(wrsMode==="simulation"||!Array.isArray(tsunamiHistory)||!tsunamiHistory.length)return;

  // Keep the latest bulletin for each official event for active-map purposes.
  const byEvent=new Map();
  tsunamiHistory.filter(q=>q&&q.isTsunamiWarning).forEach(q=>{
   const id=String(q.eventid||q.key||"");
   if(!id)return;
   const prev=byEvent.get(id);
   if(!prev||tsunamiBulletinTime(q)>tsunamiBulletinTime(prev))byEvent.set(id,q);
  });
  const latestEvents=[...byEvent.values()]
   .sort((a,b)=>tsunamiBulletinTime(b)-tsunamiBulletinTime(a));
  const active=latestEvents.filter(q=>{
   const t=tsunamiBulletinTime(q);
   return !isTsunamiEnded(q)&&Number.isFinite(t)&&t>0&&Date.now()-t<=6*60*60*1000;
  });
  const latest=active.find(q=>{
   const b=q.sshBounds;
   const url=safeTsunamiAssetUrl(q.sshmap);
   return url&&b&&Number.isFinite(Number(b.minLat))&&Number.isFinite(Number(b.minLon))&&
    Number.isFinite(Number(b.maxLat))&&Number.isFinite(Number(b.maxLon))&&
    Number(b.minLat)<Number(b.maxLat)&&Number(b.minLon)<Number(b.maxLon)&&
    Number(b.minLat)>=-90&&Number(b.maxLat)<=90&&Number(b.minLon)>=-180&&Number(b.maxLon)<=180;
  });
  if(!latest)return;
  const b=latest.sshBounds;
  // Non-interactive official raster sits beneath Leaflet markers; quake click targets remain intact.
  L.imageOverlay(safeTsunamiAssetUrl(latest.sshmap),[
   [Number(b.minLat),Number(b.minLon)],
   [Number(b.maxLat),Number(b.maxLon)]
  ],{opacity:0.62,interactive:false,alt:"Lapisan SSHmax resmi InaTEWS BMKG"}).addTo(tsunamiMapLayer);
}

function simulationQuake(scenarioIndex = simulationScenarioIndex, overrides = {}) {
  const preset = WRS_TEST_SCENARIOS[((scenarioIndex % WRS_TEST_SCENARIOS.length) + WRS_TEST_SCENARIOS.length) % WRS_TEST_SCENARIOS.length];
  const selectedMax = Math.max(5, Math.min(9, Number($("#wrsTestMagnitude")?.value || 5.6)));
  const magnitude = Math.max(3.5, Math.min(selectedMax, Number(overrides.magnitude ?? selectedMax)));
  const selectedPlace = $("#wrsTestLocation")?.value || preset.id;
  const s = WRS_TEST_SCENARIOS.find(item => item.id === selectedPlace) || preset;
  const tsunami = overrides.tsunami === true;
  const stage = tsunami && Number.isInteger(overrides.tsunamiStageIndex) ? SIMULATION_TSUNAMI_STAGES[overrides.tsunamiStageIndex] : null;
  const ended = stage?.level === "ended";
  const mag = magnitude.toFixed(1);
  const quake = {
    key: "simulation|wrs-demo-" + s.id + "-m" + mag + (tsunami ? "-tsunami" : ""),
    magnitude, lat: s.lat, lon: s.lon,
    place: "SIMULASI · " + s.place,
    depth: String(s.depth), time: new Date().toISOString(),
    potential: tsunami ? (ended ? "TSUNAMI TELAH BERAKHIR · SIMULASI LOKAL" : "SIMULASI TSUNAMI — SKENARIO UJI (BUKAN PERINGATAN RESMI)") : "DATA UJI — tidak ada potensi tsunami yang disimulasikan",
    headline: tsunami ? (ended ? "TSUNAMI TELAH BERAKHIR · SIMULASI LOKAL · BUKAN PERINGATAN RESMI" : "PERINGATAN TSUNAMI " + (stage?.pd || "SIMULASI") + " · BUKAN PERINGATAN RESMI") : "INFO GEMPA M" + mag + " · SIMULASI LOKAL",
    subject: tsunami ? "SIMULASI TSUNAMI " + (stage?.pd || "") + " · UJI LOKAL" : "SIMULASI GEMPA · UJI LOKAL",
    felt: "Simulasi intensitas MMI untuk demonstrasi — bukan observasi sensor.",
    source: "SIMULASI LOKAL / MODE TES", status: "TEST", pd: stage?.pd || "SIMULASI", ended,
    official: false, simulation: true, wrsRealtime: false,
    isTsunamiWarning: tsunami, tsunamiStageIndex: Number.isInteger(overrides.tsunamiStageIndex) ? overrides.tsunamiStageIndex : -1, shakemap: simulationMapSvg("shake", magnitude),
    sshmap: tsunami ? simulationMapSvg("ssh", magnitude) : "",
    wzmap: tsunami ? simulationMapSvg("warning", magnitude) : "",
    ttmap: tsunami ? simulationMapSvg("travel", magnitude) : "",
    instruction: tsunami
      ? "SIMULASI: untuk latihan, bayangkan mengikuti prosedur evakuasi tsunami. Ini bukan perintah evakuasi nyata."
      : "Ini latihan simulasi. Pada kejadian nyata, ikuti informasi resmi BMKG dan petugas setempat."
  };
  return quake;
}
function logSimulationTest(message, kind = "info") {
  const stamp = new Date().toLocaleTimeString("id-ID", { hour12: false });
  simulationTestLog.unshift({ stamp, message, kind });
  simulationTestLog = simulationTestLog.slice(0, 4);
  const log = $("#wrsTestLog");
  if (log) {
    log.replaceChildren();
    simulationTestLog.forEach(item => {
      const row = document.createElement("div");
      row.className = "wrs-test-log-row " + item.kind;
      row.textContent = item.stamp + " · " + item.message;
      log.appendChild(row);
    });
  }
}
function updateModeButtons() {
  document.querySelectorAll("[data-wrs-mode]").forEach(button => {
    const active = button.dataset.wrsMode === wrsMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const tools = $("#wrsTestTools");
  if (tools) tools.hidden = wrsMode !== "simulation";
  // Tell the native shell whether live monitoring is active so simulated mode never speaks real alerts.
  try {
    if (window.AndroidWrs && typeof window.AndroidWrs.setMonitoringMode === "function") {
      window.AndroidWrs.setMonitoringMode(wrsMode === "operational");
    }
  } catch (_) {}
}

/** Diagnostics are informational: never let a health-panel rendering failure interrupt monitoring. */
function updateDiagnostics(data = null, error = null, simulation = false) {
  const put = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = String(value ?? "—");
  };
  try {
    if (simulation || wrsMode === "simulation") {
      put("diagConnection", "MODE SIMULASI — data sintetis lokal");
      put("diagSources", "Feed operasional sengaja disembunyikan saat simulasi");
      put("diagFetchAge", "Tidak berlaku");
      put("diagLastSuccess", "Tidak ditampilkan pada mode simulasi");
      put("diagRetries", "0");
      put("diagError", "Tidak ada permintaan data operasional pada mode simulasi");
      return;
    }
    const fetchedAt = Date.parse(data?.fetchedAt || "");
    const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000)) : null;
    const source = data?.sources || {};
    const sourceErrors = Array.isArray(source.errors) ? source.errors : [];
    const isFallback = source.clientFallback === true || source.wrs?.ok === false;
    const stale = ageSeconds == null || ageSeconds > 45;
    put("diagConnection", error ? "GAGAL MEMUAT — mempertahankan data terakhir" :
      stale ? "DATA LAMBAT / WAKTU SUMBER TIDAK VALID" :
      isFallback ? "SUMBER CADANGAN / DATA PARSIAL" :
      sourceErrors.length ? "TERHUBUNG — SEBAGIAN SUMBER BERMASALAH" : "TERHUBUNG");
    const sourceParts = [];
    if (source.wrs) sourceParts.push("InaTEWS realtime: " + (source.wrs.ok ? "OK" : "gagal"));
    if (source.public != null) sourceParts.push("BMKG: " + source.public + "/3 feed");
    if (source.usgs != null) sourceParts.push("USGS: " + source.usgs + " event");
    if (source.tsunami != null) sourceParts.push("Buletin tsunami: " + source.tsunami);
    put("diagSources", sourceParts.join(" · ") || "Status sumber belum tersedia");
    put("diagFetchAge", ageSeconds == null ? "Waktu fetch tidak tersedia" : ageSeconds + " detik sejak fetch API");
    put("diagLastSuccess", lastSuccessfulLoadAt ? new Date(lastSuccessfulLoadAt).toLocaleString("id-ID") : "Belum ada fetch sukses sejak halaman dibuka");
    put("diagRetries", consecutiveLoadFailures);
    put("diagError", error ? String(error.message || error).slice(0, 180) :
      sourceErrors.length ? sourceErrors.join(" · ").slice(0, 180) :
      source.apiError ? String(source.apiError).slice(0, 180) : "Tidak ada error pada pemeriksaan terakhir");
  } catch (_) { /* Diagnostics must never interfere with data refresh. */ }
}
function applySimulationMode(options = {}) {
  const sample = simulationQuake(simulationScenarioIndex, options);
  quakes = [sample];
  realtimeEvents = [sample];
  currentRealtime = sample;
  currentOfficial = sample;
  const filter = $("#rtFilter");
  if (filter) filter.textContent = "MODE TES · DATA SIMULASI SAJA — BUKAN GEMPA NYATA";
  renderRealtime(sample);
  renderOfficial(sample);
  status(true, "MODE TES / SIMULASI");
  const healthText = $("#wrsHealthText");
  const healthTime = $("#wrsLastUpdated");
  const health = $("#wrsHealth");
  if (healthText) healthText.textContent = "MODE TES AKTIF · DATA SIMULASI SAJA";
  if (healthTime) healthTime.textContent = "Feed operasional tidak ditampilkan";
  updateDiagnostics(null, null, true);
  if (health) {
    health.classList.remove("is-error", "is-warning");
    health.title = "Mode tes WRS: hanya menampilkan data simulasi, bukan kejadian gempa nyata.";
  }
  updateModeButtons();
  drawMarkers(true);
  updateStats(getFilteredQuakes());
  const statusText = $("#wrsTestStatus");
  const stage = options.stageLabel ? options.stageLabel + " · " : "";
  if (statusText) statusText.textContent = stage + "M" + sample.magnitude.toFixed(1) + (sample.isTsunamiWarning ? " · TSUNAMI SIMULASI" : " · GEMPA SIMULASI") + " · BUKAN DATA RESMI";
  if (sample.isTsunamiWarning) {
    simulationTsunamiStageIndex = Number.isInteger(options.tsunamiStageIndex) ? options.tsunamiStageIndex : (simulationTsunamiStageIndex < 0 ? 0 : simulationTsunamiStageIndex);
    renderSimulationTsunamiMap(sample, simulationTsunamiStageIndex);
    renderTsunamiStagePanel(simulationTsunamiStageIndex, sample);
  } else clearSimulationTsunamiStage();
  if (options.alert) {
    if (sample.isTsunamiWarning) openTsunamiModal(sample);
    else showPopup(sample);
    playAlarmSequence(sample).catch(error => console.warn("Alarm simulasi tidak tersedia", error));
    logSimulationTest(stage + "M" + sample.magnitude.toFixed(1) + " · " + sample.place + (sample.isTsunamiWarning ? " · notifikasi tsunami simulasi" : " · gempa simulasi"), "warning");
  }
  return sample;
}
function buildSimulationSequence() {
  const max = Math.max(5, Math.min(9, Number($("#wrsTestMagnitude")?.value || 5.6)));
  const type = $("#wrsTestScenarioType")?.value || "staged";
  const after = value => Math.max(3.5, Math.min(max, Number(value.toFixed(1))));
  if (type === "major") {
    return [
      { magnitude: 4.2, label: "Aktivitas awal" },
      { magnitude: after(Math.min(5.4, max)), label: "Gempa pendahuluan" },
      { magnitude: max, label: "GEMPA UTAMA" },
      { magnitude: after(max - 1.2), label: "Gempa susulan" }
    ];
  }
  if (type === "tsunami") {
    return [
      { magnitude: 4.3, label: "Aktivitas awal" },
      { magnitude: after(Math.min(5.5, max)), label: "Gempa meningkat" },
      { magnitude: max, label: "GEMPA UTAMA" },
      ...SIMULATION_TSUNAMI_STAGES.map((stage, index) => ({
        magnitude: max, tsunami: true, tsunamiStageIndex: index,
        label: stage.level === "ended" ? "TSUNAMI TELAH BERAKHIR · SIMULASI" : stage.pd + " · " + stage.title
      }))
    ];
  }
  if (type === "aftershocks") {
    return [
      { magnitude: max, label: "Gempa utama" },
      { magnitude: after(max - 0.9), label: "Susulan 1" },
      { magnitude: after(max - 1.4), label: "Susulan 2" },
      { magnitude: after(max - 1.9), label: "Susulan 3" }
    ];
  }
  return [
    { magnitude: 3.8, label: "Tahap 1 · aktivitas awal" },
    { magnitude: 4.3, label: "Tahap 2 · gempa kecil" },
    { magnitude: 4.8, label: "Tahap 3 · mulai terasa" },
    { magnitude: after(Math.min(5.3, max)), label: "Tahap 4 · aktivitas meningkat" },
    { magnitude: after(Math.min(6.0, max)), label: "Tahap 5 · gempa kuat" },
    { magnitude: max, label: "Tahap 6 · GEMPA UTAMA" },
    { magnitude: after(max - 1.1), label: "Tahap 7 · gempa susulan" },
    { magnitude: after(max - 1.6), label: "Tahap 8 · susulan lanjutan" }
  ];
}
function clearSimulationTimer() {
  if (simulationSequenceTimer !== null) {
    clearTimeout(simulationSequenceTimer);
    simulationSequenceTimer = null;
  }
}
function updateSimulationControls() {
  const pause = $("#btnWrsTestPause");
  if (pause) {
    pause.textContent = simulationSequencePaused ? "▶ Lanjutkan" : "Ⅱ Jeda";
    pause.disabled = !simulationSequenceActive && !simulationSequencePaused;
  }
  const repeat = $("#btnWrsTestRepeat");
  if (repeat) {
    repeat.textContent = simulationSequenceRepeat ? "🔁 Ulang: ON" : "🔁 Ulang: OFF";
    repeat.setAttribute("aria-pressed", simulationSequenceRepeat ? "true" : "false");
  }
}
function finishSimulationSequence() {
  clearSimulationTimer();
  simulationSequenceActive = false;
  simulationSequencePaused = false;
  updateSimulationControls();
  const statusText = $("#wrsTestStatus");
  if (statusText) statusText.textContent = "SKENARIO SELESAI · seluruh kejadian adalah simulasi lokal";
  logSimulationTest("Rangkaian simulasi selesai.", "success");
}
function showNextSimulationEvent() {
  if (wrsMode !== "simulation" || !simulationSequence.length) return;
  clearSimulationTimer();
  if (simulationSequenceIndex >= simulationSequence.length) {
    if (simulationSequenceRepeat) simulationSequenceIndex = 0;
    else {
      finishSimulationSequence();
      return;
    }
  }
  const step = simulationSequence[simulationSequenceIndex];
  simulationSequenceIndex += 1;
  applySimulationMode({ alert: true, magnitude: step.magnitude, tsunami: step.tsunami === true, tsunamiStageIndex: step.tsunamiStageIndex, stageLabel: step.label });
  updateSimulationControls();
  if (simulationSequenceIndex < simulationSequence.length || simulationSequenceRepeat) {
    const speed = $("#wrsTestSpeed")?.value || "normal";
    const delay = speed === "slow" ? 15000 : speed === "fast" ? 4000 : 8000;
    simulationSequenceTimer = setTimeout(() => {
      if (!simulationSequencePaused && simulationSequenceActive) showNextSimulationEvent();
    }, delay);
  } else {
    simulationSequenceTimer = setTimeout(finishSimulationSequence, 1200);
  }
}
function runSimulationQuakeTest() {
  if (wrsMode !== "simulation") return;
  clearSimulationTimer();
  simulationSequence = buildSimulationSequence();
  simulationSequenceIndex = 0;
  simulationSequenceActive = true;
  simulationSequencePaused = false;
  logSimulationTest("Rangkaian dimulai · " + simulationSequence.length + " tahap · " + ($("#wrsTestScenarioType")?.selectedOptions?.[0]?.textContent || "Skenario bertahap"), "info");
  showNextSimulationEvent();
}
function toggleSimulationPause() {
  if (wrsMode !== "simulation") return;
  if (!simulationSequenceActive && !simulationSequencePaused) return;
  if (simulationSequencePaused) {
    simulationSequencePaused = false;
    simulationSequenceActive = true;
    updateSimulationControls();
    const speed = $("#wrsTestSpeed")?.value || "normal";
    const delay = speed === "slow" ? 15000 : speed === "fast" ? 4000 : 8000;
    simulationSequenceTimer = setTimeout(() => {
      if (!simulationSequencePaused && simulationSequenceActive) showNextSimulationEvent();
    }, simulationSequenceIndex < simulationSequence.length || simulationSequenceRepeat ? delay : 1200);
    logSimulationTest("Simulasi dilanjutkan.", "info");
  } else {
    simulationSequencePaused = true;
    clearSimulationTimer();
    updateSimulationControls();
    const statusText = $("#wrsTestStatus");
    if (statusText) statusText.textContent = "SIMULASI DIJEDA · tekan Lanjutkan atau Berikutnya";
    logSimulationTest("Simulasi dijeda.", "info");
  }
}
function nextSimulationEvent() {
  if (wrsMode !== "simulation") return;
  if (!simulationSequence.length || (!simulationSequenceActive && !simulationSequencePaused)) {
    runSimulationQuakeTest();
    return;
  }
  simulationSequenceActive = true;
  simulationSequencePaused = false;
  showNextSimulationEvent();
  logSimulationTest("Tahap berikutnya dijalankan manual.", "info");
}
function toggleSimulationRepeat() {
  simulationSequenceRepeat = !simulationSequenceRepeat;
  updateSimulationControls();
  logSimulationTest(simulationSequenceRepeat ? "Pengulangan otomatis diaktifkan." : "Pengulangan otomatis dimatikan.", "info");
}
function stopSimulationSequence() {
  clearSimulationTimer();
  simulationSequenceActive = false;
  simulationSequencePaused = false;
  updateSimulationControls();
  const statusText = $("#wrsTestStatus");
  if (statusText) statusText.textContent = "SIMULASI DIHENTIKAN · data operasional tetap terpisah";
  logSimulationTest("Rangkaian dihentikan oleh pengguna.", "info");
}
async function runCommunicationTest() {
  if (wrsMode !== "simulation") return;
  const statusText = $("#wrsTestStatus");
  if (statusText) statusText.textContent = "MENGUJI KONEKSI API WRS GEMPA…";
  logSimulationTest("Memulai tes koneksi ke API aplikasi.", "info");
  try {
    const response = await fetch(API + "?test=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (data?.ok !== true) throw new Error("Respons API tidak valid");
    logSimulationTest("Koneksi API aplikasi berhasil (HTTP " + response.status + "). Tidak ada data uji yang dikirim ke BMKG.", "success");
    if (statusText) statusText.textContent = "KONEKSI API APLIKASI BERHASIL · bukan tes server BMKG";
  } catch (error) {
    logSimulationTest("Koneksi API aplikasi gagal: " + String(error?.message || error).slice(0, 90), "warning");
    if (statusText) statusText.textContent = "TES KONEKSI GAGAL · periksa jaringan/API";
  }
}
function resetSimulationTests() {
  if (wrsMode !== "simulation") return;
  clearSimulationTimer();
  simulationSequence = [];
  simulationSequenceIndex = 0;
  simulationSequenceActive = false;
  simulationSequencePaused = false;
  simulationSequenceRepeat = false;
  simulationScenarioIndex = 1;
  clearSimulationTsunamiStage();
  if ($("#wrsTestMagnitude")) $("#wrsTestMagnitude").value = "5.6";
  if ($("#wrsTestLocation")) $("#wrsTestLocation").value = "sulawesi";
  if ($("#wrsTestScenarioType")) $("#wrsTestScenarioType").value = "staged";
  if ($("#wrsTestSpeed")) $("#wrsTestSpeed").value = "normal";
  simulationTestLog = [];
  const log = $("#wrsTestLog");
  if (log) log.replaceChildren();
  const statusText = $("#wrsTestStatus");
  if (statusText) statusText.textContent = "Mode Tes aktif · data uji saja";
  updateSimulationControls();
  applySimulationMode();
  logSimulationTest("Simulasi direset. Siap menjalankan skenario baru.", "info");
}
function setWrsMode(mode) {
  wrsMode = mode === "simulation" ? "simulation" : "operational";
  try { localStorage.setItem("wrsModeV1", wrsMode); } catch {}
  updateModeButtons();
  if (wrsMode === "simulation") {
    clearTsunamiMapLayer();
    if (tsunamiMapControlNode) tsunamiMapControlNode.style.display = "none";
    const testStatus = $("#wrsTestStatus");
    if (testStatus) testStatus.textContent = "Mode Tes aktif · data uji saja";
    clearSimulationTimer();
    simulationSequenceActive = false;
    simulationSequencePaused = false;
    updateSimulationControls();
    applySimulationMode();
    return;
  }
  clearSimulationTimer();
  simulationSequenceActive = false;
  simulationSequencePaused = false;
  clearSimulationTsunamiStage();
  renderOfficialTsunamiMap();
  // Invalidate any request started before the mode change. Its response may arrive
  // late and must not replace operational data or leave the UI stuck as "connecting".
  loadRequestId++;
  loadInFlight = false;
  const filter = $("#rtFilter");
  if (filter) filter.textContent = "Area Indonesia · Mag > 2 · 7 hari terakhir";
  status(false, "MENGHUBUNGKAN WRS");
  const healthText = $("#wrsHealthText");
  const healthTime = $("#wrsLastUpdated");
  const health = $("#wrsHealth");
  if (healthText) healthText.textContent = "MENGHUBUNGKAN KEMBALI KE WRS";
  if (healthTime) healthTime.textContent = "Meminta data operasional terbaru";
  if (health) health.classList.remove("is-error");
  if (operationalQuakes.length) {
    quakes = operationalQuakes;
    currentRealtime = realtimeEvents.find(q => !q.simulation) || null;
    currentOfficial = quakes.find(q => q.official) || null;
    const primary = primaryRealtimeQuake();
    renderRealtime(primary);
    if (currentOfficial) renderOfficial(currentOfficial);
    drawMarkers(true);
    updateStats(getFilteredQuakes());
  }
  load(true, true);
  scheduleRefresh();
}
document.querySelectorAll("[data-wrs-mode]").forEach(button => {
  button.addEventListener("click", () => setWrsMode(button.dataset.wrsMode));
});
$("#btnWrsTestQuake")?.addEventListener("click", runSimulationQuakeTest);
$("#btnWrsTestPause")?.addEventListener("click", toggleSimulationPause);
$("#btnWrsTestNext")?.addEventListener("click", nextSimulationEvent);
$("#btnWrsTestRepeat")?.addEventListener("click", toggleSimulationRepeat);
$("#btnWrsTestStop")?.addEventListener("click", stopSimulationSequence);
$("#btnWrsTestComm")?.addEventListener("click", runCommunicationTest);
$("#btnWrsTestReset")?.addEventListener("click", resetSimulationTests);
updateSimulationControls();

function showLoading(msg) {
  const el = $("#loadingOverlay");
  if (!el) return;
  const t = el.querySelector(".loading-text");
  if (t) t.textContent = msg || "Memuat data…";
  el.classList.remove("hidden");
}
function hideLoading() {
  const el = $("#loadingOverlay");
  if (el) el.classList.add("hidden");
}

async function load(showSpin, force = false) {
  if (wrsMode === "simulation") {
    if (!quakes.some(q => q.simulation)) applySimulationMode();
    return;
  }
  if (loadInFlight && !force) return;
  const requestId = ++loadRequestId;
  loadInFlight = true;
  if (showSpin) showLoading("Memuat data gempa…");
  try {
    let d = null;
    {
      // Android/mobile sering mengalami satu request gagal sesaat. Ulangi sekali
      // sebelum menganggap polling gagal, supaya gangguan singkat tidak mengubah status.
      let lastApiError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timeoutId = setTimeout(() => {
          try { controller?.abort(); } catch {}
        }, 12000);
        try {
          const r = await fetch(API + "?t=" + Date.now(), {
            cache: "no-store",
            headers: { accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" },
            ...(controller ? { signal: controller.signal } : {})
          });
          if (!r.ok) throw new Error("API gempa HTTP " + r.status);
          d = await r.json();
          lastApiError = null;
          break;
        } catch (apiError) {
          lastApiError = apiError;
          if (attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }
      if (lastApiError) {
        // Endpoint utama gagal dari perangkat: coba BMKG, WRS lastQL, dan USGS langsung.
        // Ini adalah mode cadangan berlabel, bukan klaim bahwa API utama sehat.
        const apiFailure = String(lastApiError?.message || lastApiError).slice(0, 120);
        const fallback = await fetchClientSide();
        if (Array.isArray(fallback.recent) && fallback.recent.length) {
          d = {
            ...fallback,
            ok: true,
            count: fallback.recent.length,
            realtime: fallback.realtime || null,
            realtimeEvents: Array.isArray(fallback.realtimeEvents) ? fallback.realtimeEvents : [],
            tsunamiHistory: Array.isArray(tsunamiHistory) ? tsunamiHistory : [],
            sources: {
              ...(fallback.sources || {}),
              clientFallback: true,
              apiError: apiFailure,
              errors: [...new Set([...(fallback.sources?.errors || []), "API utama gagal dari perangkat: " + apiFailure])]
            }
          };
          lastApiError = null;
        } else {
          throw new Error("API utama gagal dan sumber cadangan belum mengirim data: " + apiFailure);
        }
      }
    }

    // Ignore responses from an old mode or superseded request.
    if (requestId !== loadRequestId || wrsMode === "simulation") return;

    // Cloudflare Pages API adalah satu-satunya jalur data aplikasi.
    // Jangan diam-diam mengganti API dengan fetch browser karena hasilnya bisa
    // membuat data cadangan terlihat seperti aliran utama.
    if (!d || d.ok !== true || !Array.isArray(d.recent)) {
      throw new Error("API gempa tidak mengembalikan respons yang valid");
    }
    // Reset only after receiving a structurally valid API response.
    consecutiveLoadFailures = 0;
    lastSuccessfulLoadAt = Date.now();

    const incoming = d.recent;
    // Persist the last structurally valid catalogue so a page reload during an outage
    // can still show the last known events without pretending they are live.
    try {
      localStorage.setItem("wrsLastGoodCatalogV1", JSON.stringify({
        savedAt: Date.now(),
        recent: incoming,
        realtimeEvents: Array.isArray(d.realtimeEvents) ? d.realtimeEvents : [],
        tsunamiHistory: Array.isArray(d.tsunamiHistory) ? d.tsunamiHistory : []
      }));
    } catch (storageError) {
      console.warn("Katalog WRS tidak dapat disimpan ke penyimpanan lokal.", storageError);
    }
    operationalQuakes = incoming;
    realtimeEvents = Array.isArray(d.realtimeEvents) ? d.realtimeEvents : [];
    if (!incoming.length) {
      const hasPreviousData = quakes.length > 0;
      status(false, hasPreviousData ? "MEMAKAI DATA TERAKHIR" : "MENUNGGU DATA");
      const healthText = $("#wrsHealthText");
      const healthTime = $("#wrsLastUpdated");
      const health = $("#wrsHealth");
      if (healthText) healthText.textContent = hasPreviousData ? "MENUNGGU PEMBARUAN" : "SUMBER BELUM TERSEDIA";
      if (healthTime) healthTime.textContent = hasPreviousData ? "Data sebelumnya dipertahankan" : "Coba muat ulang sebentar lagi";
      if (health) {
        health.classList.add("is-error");
        health.title = "Belum ada katalog gempa yang diterima; data yang sudah tampil tidak dihapus.";
      }
      return;
    }
    const oldFingerprint = quakes.map(q => q.key + ":" + q.magnitude).join("|");
    quakes = incoming;
    if (Array.isArray(d.tsunamiHistory)) { tsunamiHistory = d.tsunamiHistory; renderOfficialTsunamiMap(); }
    // Saat pertama kali dibuka, pusatkan peta tepat pada marker event terbaru
    // yang ditampilkan di daftar/peta. Jangan mengganggu posisi pengguna saat refresh berikutnya.
    if (!window.__wrsInitialMapCentered && map) {
      const preferred = d.realtime || d.official || quakes[0];
      const focus = preferred && Number.isFinite(Number(preferred.lat)) && Number.isFinite(Number(preferred.lon))
        ? preferred
        : quakes.find(q => Number.isFinite(q.lat) && Number.isFinite(q.lon));
      if (focus) {
        map.setView([focus.lat, focus.lon], Math.max(map.getZoom(), 6), { animate: false });
        window.__wrsInitialMapCentered = true;
      }
    }
    const newFingerprint = quakes.map(q => q.key + ":" + q.magnitude).join("|");
    const clientFallback = d.sources?.clientFallback === true;
    const wrsFeedOk = d.sources?.wrs?.ok === true || (!clientFallback && d.sources?.wrs == null && !(d.sources?.errors || []).includes("InaTEWS QL"));
    const fetchedAtMs = Date.parse(d.fetchedAt || "");
    const apiAgeSeconds = Number.isFinite(fetchedAtMs) ? Math.max(0, Math.floor((Date.now() - fetchedAtMs) / 1000)) : null;
    const apiDataStale = apiAgeSeconds == null || apiAgeSeconds > 45;
    const usingFallback = clientFallback || !wrsFeedOk || apiDataStale;
    status(true, apiDataStale ? "DATA LAMBAT" : clientFallback
      ? (wrsFeedOk ? "WRS CADANGAN LANGSUNG" : "SUMBER CADANGAN")
      : (wrsFeedOk ? "WRS LIVE" : "CADANGAN · WRS OFFLINE"));
    const healthText = $("#wrsHealthText");
    const healthTime = $("#wrsLastUpdated");
    const health = $("#wrsHealth");
    if (healthText) {
      healthText.textContent = apiDataStale
        ? "PEMBARUAN TERLAMBAT · DATA TERAKHIR DIPERTAHANKAN"
        : clientFallback
          ? (wrsFeedOk ? "API UTAMA TERGANGGU · WRS LANGSUNG CADANGAN AKTIF" : "API UTAMA TERGANGGU · DATA CADANGAN BMKG/USGS")
          : (wrsFeedOk ? ((d.sources?.errors?.length) ? "WRS TERHUBUNG · DATA PARSIAL" : "WRS REALTIME TERHUBUNG") : (quakes.length ? "WRS OFFLINE · DATA CADANGAN" : "WRS OFFLINE · DATA TIDAK TERSEDIA"));
    }
    if (healthTime) {
      const fetchedText = Number.isFinite(fetchedAtMs)
        ? new Date(fetchedAtMs).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "waktu sumber tidak tersedia";
      healthTime.textContent = "Fetch API " + fetchedText +
        (apiAgeSeconds == null ? "" : " · usia " + apiAgeSeconds + " dtk") +
        (clientFallback ? " · API utama: " + String(d.sources?.apiError || "gagal") : "");
    }
    if (health) {
      // Data parsial saat feed realtime masih aktif adalah peringatan, bukan kegagalan total.
      // Merah hanya untuk data basi, API utama gagal, atau feed WRS realtime tidak tersedia.
      const partialSources = !!d.sources?.errors?.length;
      health.classList.toggle("is-error", apiDataStale || clientFallback || !wrsFeedOk);
      health.classList.toggle("is-warning", !apiDataStale && !clientFallback && wrsFeedOk && partialSources);
      const sourceErrors = Array.isArray(d.sources?.errors) ? d.sources.errors : [];
      const sourceErrorDetail = sourceErrors.length
        ? " Sumber yang gagal: " + sourceErrors.join("; ") + "."
        : "";
      health.title = apiDataStale
        ? "Respons API berumur lebih dari 45 detik atau waktu fetch tidak valid. Data terakhir dipertahankan dan tidak dianggap realtime."
        : clientFallback
          ? "Endpoint API utama gagal diakses dari perangkat. Jalur cadangan BMKG/WRS/USGS dicoba bila tersedia. Penyebab: " + String(d.sources?.apiError || "tidak diketahui")
          : !wrsFeedOk
            ? "Feed realtime InaTEWS/WRS tidak tersedia; katalog cadangan tetap ditampilkan jika ada." + sourceErrorDetail
            : partialSources
              ? "Feed WRS realtime masih terhubung, tetapi minimal satu sumber pendukung gagal. Ini tidak otomatis berarti WRS offline." + sourceErrorDetail
              : "Feed realtime InaTEWS/WRS diterima; tidak ada kegagalan sumber yang dilaporkan.";
    }
    const s = d.sources || {};
    updateDiagnostics(d);
    const sourceSummary = [`${d.count ?? quakes.length} event`];
    if (s.public != null) sourceSummary.push(`BMKG ${s.public}/3`);
    if (s.usgs != null) sourceSummary.push(`USGS ${s.usgs}`);
    $("#srcCount").textContent = sourceSummary.join(" · ");

    const off = d.official || quakes.find((q) => q.official) || quakes[0];
    currentOfficial = off || null;
    if (off) renderOfficial(off);

    // Keep WRS realtime and the official/catalog card as separate event streams.
    currentRealtime = d.realtime || realtimeEvents[0] || null;
    const primary = primaryRealtimeQuake();
    renderRealtime(primary);
    const rtFilter = $("#rtFilter");
    if (rtFilter) rtFilter.textContent = "Area Indonesia · Mag > 2 · 7 hari terakhir";
    updateModeButtons();

    if (oldFingerprint !== newFingerprint || showSpin) drawMarkers(true);
    else updateStats(getFilteredQuakes());
    processNew();

    // Push deep link: resolve the exact event after fresh data has arrived.
    const params = new URLSearchParams(window.location.search);
    const requestedKey = params.get("quake");
    if (requestedKey && !window.__wrsHandledQuakeDeepLink) {
      const paramsLat = Number(params.get("lat"));
      const paramsLon = Number(params.get("lon"));
      const paramsMag = Number(params.get("mag"));
      const paramsTime = params.get("time");
      const target = quakes.find((q) => String(q.key || "") === requestedKey) ||
        quakes.find((q) => Number.isFinite(paramsLat) && Number.isFinite(paramsLon) &&
          Math.abs(Number(q.lat) - paramsLat) < 0.08 && Math.abs(Number(q.lon) - paramsLon) < 0.08 &&
          (!Number.isFinite(paramsMag) || Math.abs(Number(q.magnitude) - paramsMag) < 0.2) &&
          (!paramsTime || Math.abs(new Date(q.time).getTime() - new Date(paramsTime).getTime()) < 6 * 3600000));
      if (target) {
        window.__wrsHandledQuakeDeepLink = true;
        if (Number.isFinite(target.lat) && Number.isFinite(target.lon)) {
          map?.flyTo([target.lat, target.lon], 8, { duration: 0.8 });
          const marker = L.circleMarker([target.lat, target.lon], {
            radius: 22, color: "#ffffff", weight: 3, fillColor: "#38bdf8", fillOpacity: 0.18,
            className: "quake-deeplink-highlight"
          }).addTo(map);
          setTimeout(() => { try { map.removeLayer(marker); } catch {} }, 12000);
        }
        openModal(target);
      } else if (requestedKey && !window.__wrsDeepLinkRetry) {
        window.__wrsDeepLinkRetry = setTimeout(() => {
          window.__wrsHandledQuakeDeepLink = false;
          window.__wrsDeepLinkRetry = null;
          load(false);
        }, 2500);
      }
    }
  } catch (e) {
    if (requestId !== loadRequestId || wrsMode === "simulation") return;
    consecutiveLoadFailures += 1;
    updateDiagnostics(null, e);
    console.warn("WRS refresh gagal; percobaan ulang dijadwalkan.", e);
    const healthText = $("#wrsHealthText");
    const healthTime = $("#wrsLastUpdated");
    const health = $("#wrsHealth");
    // Restore the last good catalogue after a reload if every live request fails.
    // Its age is shown explicitly below; it is never labelled as a live feed.
    if (!quakes.length) {
      try {
        const saved = JSON.parse(localStorage.getItem("wrsLastGoodCatalogV1") || "null");
        if (saved && Array.isArray(saved.recent) && saved.recent.length) {
          quakes = saved.recent;
          operationalQuakes = saved.recent;
          realtimeEvents = Array.isArray(saved.realtimeEvents) ? saved.realtimeEvents : [];
          if (Array.isArray(saved.tsunamiHistory)) tsunamiHistory = saved.tsunamiHistory;
          const savedAt = Number(saved.savedAt);
          window.__wrsRestoredCatalogAt = Number.isFinite(savedAt) ? savedAt : null;
          if (map) drawMarkers(true);
          updateStats(getFilteredQuakes());
        }
      } catch (storageError) {
        console.warn("Katalog WRS tersimpan tidak dapat dipulihkan.", storageError);
      }
    }
    const hasCachedEvents = quakes.length > 0;
    const restoredAt = Number(window.__wrsRestoredCatalogAt || 0);
    const lastOkText = lastSuccessfulLoadAt
      ? "Data terakhir berhasil diterima " + new Date(lastSuccessfulLoadAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : restoredAt
        ? "Katalog tersimpan " + new Date(restoredAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "medium" }) + " (bukan realtime)"
        : "Belum ada data berhasil diterima pada sesi ini";
    // Jangan ubah indikator koneksi pada satu-dua kegagalan sesaat.
    // Pertahankan layar/marker dan status terakhir yang berhasil, sambil polling otomatis tetap berjalan.
    // Setelah 6 kegagalan beruntun, jelaskan bahwa data yang tampil adalah data terakhir,
    // tetapi jangan menampilkan status "OFFLINE" atau "MENYAMBUNG ULANG".
    if (hasCachedEvents && consecutiveLoadFailures < 6) {
      if (health) {
        health.title = "Satu pembaruan gagal; data dan marker terakhir tetap tampil. Pemantauan mencoba kembali otomatis.";
      }
    } else if (hasCachedEvents) {
      status(true, "DATA TERAKHIR · RETRY OTOMATIS");
      if (healthText) healthText.textContent = "PEMBARUAN TERLAMBAT · DATA TERAKHIR DIPERTAHANKAN";
      if (healthTime) healthTime.textContent = lastOkText + " · " + String(e?.message || e).slice(0, 85);
      if (health) {
        health.classList.add("is-error");
        health.title = "Pembaruan belum berhasil setelah beberapa percobaan. Data dan marker terakhir tetap tampil; polling otomatis berlanjut. Penyebab terakhir: " + String(e?.message || e).slice(0, 180);
      }
    } else {
      status(false, "MENUNGGU DATA");
      if (healthText) healthText.textContent = "MENUNGGU DATA PERTAMA · MENCOBA OTOMATIS";
      if (healthTime) healthTime.textContent = lastOkText + " · " + String(e?.message || e).slice(0, 85);
      if (health) {
        health.classList.add("is-error");
        health.title = "Belum ada data berhasil diterima. Aplikasi akan terus mencoba otomatis. Penyebab terakhir: " + String(e?.message || e).slice(0, 180);
      }
    }
  } finally {
    // An older request must not clear the in-flight state of a newer request.
    if (requestId === loadRequestId) {
      loadInFlight = false;
      hideLoading();
    }
  }
}

/* Timeline 7 hari: ringkasan event per hari, dibangun dari katalog yang sedang tersedia. */
function renderHistoryTimeline() {
  const root = $("#histTimeline");
  if (!root) return;
  const now = Date.now();
  const bins = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now - (6 - i) * 86400000);
    date.setHours(0, 0, 0, 0);
    const next = new Date(date.getTime() + 86400000);
    const events = quakes.filter(q => {
      const t = new Date(q.time).getTime();
      return Number.isFinite(t) && t >= date.getTime() && t < next.getTime();
    });
    return { date, events };
  });
  const max = Math.max(1, ...bins.map(b => b.events.length));
  root.innerHTML = '<div class="timeline-title">Aktivitas 7 hari terakhir</div><div class="timeline-bars">' +
    bins.map(b => {
      const strong = b.events.filter(q => q.magnitude >= 4).length;
      const height = Math.max(4, Math.round(b.events.length / max * 48));
      const label = b.date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
      return '<button type="button" class="timeline-day" data-day="' + b.date.toISOString().slice(0,10) +
        '" title="' + label + ': ' + b.events.length + ' event, ' + strong + ' M4+" aria-label="' + label + ', ' + b.events.length + ' event">' +
        '<span class="timeline-count">' + b.events.length + '</span><span class="timeline-bar" style="height:' + height + 'px"></span><span class="timeline-label">' + label + '</span></button>';
    }).join('') + '</div><div class="timeline-note">Jumlah berdasarkan event yang tersedia di katalog saat ini; bukan arsip historis tanpa batas.</div>';
  root.querySelectorAll(".timeline-day").forEach(btn => btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    const selected = quakes.filter(q => q.time && new Date(q.time).toISOString().slice(0,10) === day)
      .sort((a,b) => new Date(b.time) - new Date(a.time));
    const body = $("#histBody");
    if (!body) return;
    body.innerHTML = "";
    selected.forEach(q => {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="hist-mag"></td><td></td><td></td><td></td>';
      tr.children[0].textContent = Number(q.magnitude).toFixed(1);
      tr.children[1].textContent = shortDate(q);
      tr.children[2].textContent = q.place || "Wilayah tidak diketahui";
      tr.children[3].textContent = (q.depth ?? "—") + " km";
      tr.addEventListener("click", () => { window._modalQuake = q; openModal(q); });
      body.appendChild(tr);
    });
    $("#histTitle").textContent = "Timeline · " + new Date(day + "T12:00:00").toLocaleDateString("id-ID", { weekday:"long", day:"numeric", month:"long" });
    $("#histCount").textContent = selected.length + " event";
    $("#histMap")?.classList.toggle("hidden", selected.length === 0);
  }));
}

/* History / daftar modal — mode: all | strong | felt | tsunami */
function openHistory(mode = "all") {
  renderHistoryTimeline();
  const body = $("#histBody");
  body.innerHTML = "";
  const titles = {
    all: "Semua Event (filter aktif)",
    strong: "Gempa M≥4",
    felt: "Gempa Dirasakan",
    tsunami: "Riwayat & Peringatan Tsunami",
  };
  let list;
  if (mode === "strong") list = quakes.filter((q) => q.magnitude >= 4);
  else if (mode === "felt") list = quakes.filter((q) => q.felt && String(q.felt).trim());
  else if (mode === "tsunami") {
    // Data resmi sama dengan https://inatews.bmkg.go.id/web/tsunami
    list = tsunamiHistory.length
      ? tsunamiHistory.slice()
      : quakes.filter((q) => isTsunamiPotential(q.potential));
  } else list = getFilteredQuakes();

  list = list.slice(0, 100);
  const titleEl = $("#histTitle");
  if (titleEl) {
    titleEl.textContent =
      mode === "tsunami" ? "DAFTAR 30 TSUNAMI TERAKHIR (InaTEWS)" : titles[mode] || titles.all;
  }
  $("#histCount").textContent =
    mode === "tsunami" ? list.length + " buletin PD" : list.length + " event";

  const banner = $("#histTsunamiBanner");
  if (banner) {
    if (mode === "tsunami") {
      banner.classList.remove("hidden");
      banner.querySelector("span") &&
        (banner.querySelector("span").textContent =
          "Sumber: cdn.bmkg.go.id/last30tsunamievent.xml (sama dengan inatews.bmkg.go.id/web/tsunami). Klik baris untuk detail + peta.");
    } else banner.classList.add("hidden");
  }

  const head = $("#histHeadRow");
  if (head) {
    head.innerHTML =
      mode === "tsunami"
        ? "<th>M</th><th>Waktu</th><th>Peringatan / Wilayah</th><th>Kedalaman</th><th>Aksi</th>"
        : "<th>M</th><th>Waktu</th><th>Wilayah</th><th>Kedalaman</th><th>Aksi</th>";
  }

  list.forEach((q) => {
    const tr = document.createElement("tr");
    if (mode === "tsunami") {
      const pd =
        q.pd ||
        (String(q.subject || "").match(/PD[-\s]?([\d.]+)/i) || [])[1] ||
        "";
      const pdLabel = q.subject || (pd ? `WARNING TSUNAMI PD-${pd}` : "WARNING TSUNAMI");
      const when = q.date && q.timeLocal ? `${q.date} ${q.timeLocal}` : shortDate(q);
      const ended = isTsunamiEnded(q);
      const statusBadge = ended
        ? '<span class="ts-badge" style="background:#15803d">BERAKHIR</span>'
        : '<span class="ts-badge">AKTIF?</span>';
      tr.innerHTML = `<td class="hist-mag">${Number(q.magnitude).toFixed(1)}</td>
        <td>${when}</td>
        <td><span class="ts-pd">${pdLabel}</span><br>${q.place || "—"} <span class="ts-badge">PD${pd ? "-" + pd : ""}</span> ${statusBadge}</td>
        <td>${q.depth} km</td>`;
      tr.onclick = () => {
        openTsunamiModal(q);
        if (Number.isFinite(q.lat)) {
          map.flyTo([q.lat, q.lon], 7);
          if (histMap) histMap.setView([q.lat, q.lon], 6);
        }
      };
    } else {
      tr.innerHTML = `<td class="hist-mag">${q.magnitude.toFixed(1)}</td><td>${shortDate(q)}</td><td>${q.place}${isTsunamiPotential(q.potential) ? ' <span class="ts-badge">TS</span>' : ""}</td><td>${q.depth} km</td>`;
      tr.onclick = () => {
        openModal(q);
        if (Number.isFinite(q.lat)) {
          map.flyTo([q.lat, q.lon], 8);
          if (histMap) histMap.setView([q.lat, q.lon], 7);
        }
      };
    }
    const actions = document.createElement("td");
    actions.className = "hist-actions";
    actions.innerHTML = '<button type="button" class="hist-action-download">Unduh</button><button type="button" class="hist-action-share">Bagikan</button>';
    actions.querySelector(".hist-action-download").addEventListener("click", (event) => {
      event.stopPropagation();
      window._modalQuake = q;
      const date = String(q.time || q.date || new Date().toISOString()).slice(0, 10);
      saveModalAsImage(null, "gempa_M" + Number(q.magnitude || 0).toFixed(1) + "_" + date + ".png");
    });
    actions.querySelector(".hist-action-share").addEventListener("click", (event) => {
      event.stopPropagation();
      shareQuake(q);
    });
    tr.appendChild(actions);
    body.appendChild(tr);
  });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8">${
      mode === "tsunami"
        ? "Belum ada data buletin tsunami. Pastikan Functions Netlify ter-deploy."
        : "Tidak ada data untuk kategori ini."
    }</td></tr>`;
  }

  $("#modalHistory").classList.remove("hidden");
  setTimeout(() => {
    if (!histMap) {
      histMap = L.map("histMap", { zoomControl: false, attributionControl: false }).setView([-3.5, 118], 4);
      L.tileLayer(BASEMAPS.sat.url, { maxZoom: 18, attribution: BASEMAPS.sat.attr }).addTo(histMap);
    }
    histMap.invalidateSize();
    histMap.eachLayer((l) => {
      if (l instanceof L.Marker || l instanceof L.CircleMarker) histMap.removeLayer(l);
    });
    list
      .filter((q) => Number.isFinite(q.lat))
      .slice(0, 50)
      .forEach((q) => {
        L.circleMarker([q.lat, q.lon], {
          radius: Math.max(4, q.magnitude),
          // Samakan legenda peta riwayat: isi = magnitudo, tepi = kedalaman.
          color: depthColor(q.depth),
          fillColor: magColor(q.magnitude),
          fillOpacity: 0.9,
          weight: 1.5,
        })
          .addTo(histMap)
          .on("click", () => openModal(q));
      });
  }, 100);
}

/* Events */
document.querySelectorAll("#optVoice, #prefVoice").forEach((element) => {
  element.addEventListener("change", (event) => {
    try {
      if (window.AndroidWrs && typeof window.AndroidWrs.setVoiceEnabled === "function") {
        window.AndroidWrs.setVoiceEnabled(!!event.target.checked);
      }
    } catch (error) {
      console.warn("Could not sync Android voice preference", error);
    }
  });
});
$("#prefVibrate")?.addEventListener("change", (event) => {
  try {
    if (window.AndroidWrs && typeof window.AndroidWrs.setVibrationEnabled === "function") {
      window.AndroidWrs.setVibrationEnabled(!!event.target.checked);
    }
  } catch (error) {
    console.warn("Could not sync Android vibration preference", error);
  }
});

$("#btnAlarm").onclick = async () => {
  try {
    await ensureAudio();
    if ("speechSynthesis" in window) {
      speechSynthesis.getVoices();
      try {
        const u0 = new SpeechSynthesisUtterance(" ");
        u0.volume = 0;
        speechSynthesis.speak(u0);
      } catch {}
    }
    alarmOn = true;
    $("#btnAlarm")?.classList.add("on");
    $("#alarmStatus").textContent = "Alarm · aktif (bel + suara)";
    // Demo: bel sekolah normal
    playSchoolBell("normal").then((ms) => {
      setTimeout(() => {
        if ($("#optVoice")?.checked) {
          const u = new SpeechSynthesisUtterance("Alarm aktif. Bel dan suara siap.");
          u.lang = "id-ID";
          u.volume = 1;
          const idv = getIdVoice();
          if (idv) u.voice = idv;
          speechSynthesis.speak(u);
        }
      }, Math.max(ms, 500) + 100);
    });
  } catch (err) {
    console.warn(err);
    $("#alarmStatus").textContent = "Browser blokir audio — ketuk lagi / izinkan suara";
  }
};

$("#popupClose").onclick = () => { clearTimeout(popupTimer); $("#popupNew").classList.add("hidden"); renderRealtime(quakes[0]); };
$("#modalClose").onclick = () => $("#modalDetail").classList.add("hidden");
$("#modalDetail").addEventListener("click", (e) => {
  if (e.target === $("#modalDetail")) $("#modalDetail").classList.add("hidden");
});
$("#histClose").onclick = () => $("#modalHistory").classList.add("hidden");
$("#modalHistory").addEventListener("click", (e) => {
  if (e.target === $("#modalHistory")) $("#modalHistory").classList.add("hidden");
});
$("#tsunamiClose")?.addEventListener("click", closeTsunamiModal);
$("#tsunamiCloseBtn")?.addEventListener("click", closeTsunamiModal);
$("#modalTsunamiAlert")?.addEventListener("click", (e) => {
  if (e.target === $("#modalTsunamiAlert")) closeTsunamiModal();
});

function buildWrsEventUrl(q) {
  const base = window.location.origin || "https://wrs-gempa-final.pages.dev";
  const url = new URL(base + window.location.pathname);
  url.searchParams.set("event", String(q?.key || ""));
  if (Number.isFinite(Number(q?.lat)) && Number.isFinite(Number(q?.lon))) {
    url.searchParams.set("lat", String(q.lat));
    url.searchParams.set("lon", String(q.lon));
    url.hash = "map=7/" + Number(q.lat).toFixed(4) + "/" + Number(q.lon).toFixed(4);
  }
  return url.toString();
}
function buildShareText(q) {
  return `INFO GEMPA M${Number(q.magnitude || 0).toFixed(1)} — ${q.place || "Lokasi belum tersedia"}\nWaktu: ${fmtTime(q)}\nSumber: ${q.source || "BMKG / InaTEWS"}\n\nDetail gempa dan titik episenter di WRS GEMPA:\n${buildWrsEventUrl(q)}`;
}

async function shareQuake(q) {
  if (!q) return;
  const text = buildShareText(q);
  // On browsers that support file sharing, share the same map card used by Save PNG.
  if (navigator.share && navigator.canShare && typeof html2canvas === "function") {
    let exportEl = null;
    try {
      exportEl = buildExportCard(q);
      const imgs = [...exportEl.querySelectorAll("img")];
      await Promise.all(imgs.map(img => new Promise(resolve => {
        if (img.complete && img.naturalWidth > 0) return resolve();
        img.onload = resolve; img.onerror = resolve; setTimeout(resolve, 3500);
      })));
      const canvas = await html2canvas(exportEl, {
        backgroundColor: "#f8fafc", scale: 2, useCORS: true, allowTaint: false,
        logging: false, width: exportEl.offsetWidth, height: exportEl.scrollHeight
      });
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], "info-gempa-M" + Number(q.magnitude).toFixed(1) + ".png", { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: "Info Gempa M" + Number(q.magnitude).toFixed(1), text, files: [file] });
          return;
        }
      }
    } catch (err) {
      // Sharing may be cancelled or file sharing may not be supported; continue with text fallback.
      if (err?.name === "AbortError") return;
      console.warn("Share gambar tidak tersedia, beralih ke teks", err);
    } finally {
      exportEl?.remove();
    }
  }
  if (navigator.share) {
    try { await navigator.share({ title: "Gempa M" + Number(q.magnitude).toFixed(1), text }); return; }
    catch (err) { if (err?.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    alert("Info gempa dan tautan peta episenter disalin.");
  } catch {
    prompt("Salin info gempa dan tautan peta episenter ini:", text);
  }
}

/**
 * Bangun kartu ekspor terang (mirip BMKG) supaya PNG tidak gelap/buram.
 */
function buildExportCard(q, page = 0, pageCount = 1, pageLabel = "Ringkasan") {
  const wrap = document.createElement("div");
  wrap.id = "exportCard";
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:390px;height:693px;box-sizing:border-box;background:#f8fafc;color:#0f172a;font-family:Arial,Segoe UI,sans-serif;overflow:hidden;z-index:99999;";
  const mag = Number(q.magnitude); const magStr = Number.isFinite(mag) ? mag.toFixed(1) : "—";
  const when = q.date && q.timeLocal ? q.date + " " + q.timeLocal : (typeof fmtTime === "function" ? fmtTime(q) : String(q.time || "—"));
  const isTs = !!(q.isTsunamiWarning || isTsunamiPotential(q.potential) || /tsunami/i.test(q.subject || ""));
  const title = isTs ? (q.subject || "INFORMASI TSUNAMI") : (q.felt ? "INFO GEMPA DIRASAKAN" : (mag >= 5 ? "INFO GEMPA M≥5" : "INFO GEMPA"));
  const esc = v => String(v == null ? "—" : v).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const exportMmiUrl = q.shakemap || q.exportShakeMapUrl || ""; const maps = []; if(exportMmiUrl) maps.push({label:q.shakemap ? "ShakeMap BMKG / MMI" : "ShakeMap USGS / MMI",url:exportMmiUrl}); if(q.sshmap) maps.push({label:"SSHmax · Tinggi muka laut",url:q.sshmap}); if(q.wzmap) maps.push({label:"Warning Zone",url:q.wzmap}); if(q.ttmap) maps.push({label:"Estimasi waktu tiba tsunami",url:q.ttmap});
  const hasCoords = Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lon)); const lat=Number(q.lat), lon=Number(q.lon);
  const satUrl = hasCoords ? "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox="+encodeURIComponent((lon-5)+","+(lat-2.25)+","+(lon+5)+","+(lat+2.25))+"&bboxSR=4326&imageSR=4326&size=976,440&format=jpg&f=image" : "";
  const box = (h,body) => '<section style="margin-top:8px;padding:9px 10px;background:#fff;border:1px solid #dbe3ee;border-radius:8px"><div style="font-size:10px;font-weight:800;color:#475569;margin-bottom:5px">' + h + '</div>' + body + '</section>';
  const sat = hasCoords ? '<div style="position:relative;height:165px;overflow:hidden;border-radius:8px;background:#dbeafe"><img src="' + satUrl + '" crossorigin="anonymous" alt="Peta satelit episenter" style="width:100%;height:165px;object-fit:cover;display:block"><span style="position:absolute;left:50%;top:50%;width:' + Math.max(9, Math.min(36, radius(q.magnitude) * 2)) + 'px;height:' + Math.max(9, Math.min(36, radius(q.magnitude) * 2)) + 'px;transform:translate(-50%,-50%);border:' + (Number(q.depth) > 600 ? 3 : 2) + 'px solid ' + depthColor(q.depth) + ';border-radius:50%;background:' + magColor(q.magnitude) + ';box-shadow:0 0 0 4px ' + depthColor(q.depth) + '55' + '"></span><b style="position:absolute;right:6px;bottom:6px;background:#07111fdd;color:white;padding:4px 6px;border-radius:4px;font-size:10px">WRS Gempa</b></div><div style="font-size:9px;color:#64748b;margin-top:4px">Isi titik = magnitudo · Tepi titik = kedalaman · Citra satelit © Esri dan penyedia datanya</div><div style="margin-top:6px;padding:7px 8px;background:#f8fafc;border:1px solid #dbe3ee;border-radius:7px"><div style="font-size:10px;font-weight:800;color:#334155;border-bottom:1px solid #dbe3ee;padding-bottom:4px;margin-bottom:4px">Legenda</div><div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:4px 0"><b style="font-size:9px;color:#64748b;margin-right:2px">Isi = Mag:</b><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#6b7280;color:#fff;font-size:8px;font-weight:800">1</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#60a5fa;color:#fff;font-size:8px;font-weight:800">2</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#fbbf24;color:#fff;font-size:8px;font-weight:800">3</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#f59e0b;color:#fff;font-size:8px;font-weight:800">4</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#ef4444;color:#fff;font-size:8px;font-weight:800">5</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#dc2626;color:#fff;font-size:8px;font-weight:800">6</span><span style="display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#b91c1c;color:#fff;font-size:8px;font-weight:800">7</span><span style="display:inline-grid;place-items:center;width:21px;height:17px;border-radius:9px;background:#7c3aed;color:#fff;font-size:8px;font-weight:800">8+</span></div><div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:4px 0"><b style="font-size:9px;color:#64748b;margin-right:2px">Tepi = Kedalaman:</b><span style="white-space:nowrap;font-size:8px"><i style="display:inline-block;width:9px;height:9px;background:#ef4444;border:1px solid #cbd5e1;border-radius:2px;vertical-align:middle;margin-right:2px"></i>≤50</span><span style="white-space:nowrap;font-size:8px"><i style="display:inline-block;width:9px;height:9px;background:#eab308;border:1px solid #cbd5e1;border-radius:2px;vertical-align:middle;margin-right:2px"></i>51–100</span><span style="white-space:nowrap;font-size:8px"><i style="display:inline-block;width:9px;height:9px;background:#86efac;border:1px solid #cbd5e1;border-radius:2px;vertical-align:middle;margin-right:2px"></i>101–250</span><span style="white-space:nowrap;font-size:8px"><i style="display:inline-block;width:9px;height:9px;background:#16a34a;border:1px solid #cbd5e1;border-radius:2px;vertical-align:middle;margin-right:2px"></i>251–600</span><span style="white-space:nowrap;font-size:8px"><i style="display:inline-block;width:9px;height:9px;background:#1e3a8a;border:1px solid #cbd5e1;border-radius:2px;vertical-align:middle;margin-right:2px"></i>&gt;600</span></div><div style="font-size:8px;color:#64748b;margin-top:4px"><b>Ukuran:</b> simbol lebih besar = magnitudo lebih tinggi</div></div>' : '<div style="font-size:11px">Koordinat episenter tidak tersedia.</div>';
  const rows = [["Lokasi",q.place],["Waktu",when],["Magnitudo","M "+magStr],["Koordinat",typeof fmtCoord==="function"?fmtCoord(q):(q.lat+", "+q.lon)],["Kedalaman",(q.depth||"—")+" km"],["Sumber",q.source||"BMKG / InaTEWS"]].map(r=>'<div style="display:flex;gap:7px;padding:5px 0;border-bottom:1px solid #e2e8f0"><b style="width:92px;flex-shrink:0;font-size:10px;color:#64748b">' + esc(r[0]) + '</b><span style="font-size:10px;font-weight:700;overflow-wrap:anywhere">' + esc(r[1]) + '</span></div>').join("");
  const zones = isTs && typeof parseTsunamiZones==="function" ? parseTsunamiZones(q) : [];
  const defs = [{page:0,label:"Ringkasan"},{page:1,label:"Dampak dan ShakeMap"}];
  if(isTs){defs.push({page:2,label:"Arahan keselamatan"});for(let i=0;i<Math.max(1,Math.ceil(zones.length/8));i++)defs.push({page:3+i,label:"Wilayah tsunami "+(i+1)});defs.push({page:3+Math.max(1,Math.ceil(zones.length/8)),label:"Peta tsunami"});}
  let body = "";
  if(page===0){ body=box("RINGKASAN KEJADIAN",rows)+box("PETA SATELIT & TITIK EPISENTER",sat)+box(isTs?"STATUS INFORMASI TSUNAMI":"STATUS POTENSI",'<div style="font-size:10px;line-height:1.45;font-weight:700">' + esc(q.headline||q.potential||q.subject||"Tidak ada pernyataan potensi pada data ini.") + '</div>'); }
  else if(page===1){ const felt=esc(q.felt||"Data wilayah yang merasakan belum tersedia pada feed ini."); const exportMmiUrl = q.shakemap || q.exportShakeMapUrl || ""; const sm=exportMmiUrl?'<img src="' + esc(exportMmiUrl) + '" crossorigin="anonymous" alt="Peta intensitas guncangan MMI" style="width:100%;max-height:330px;object-fit:contain;display:block;background:#fff;border-radius:6px">' : '<div style="font-size:10px;line-height:1.5">ShakeMap MMI resmi tidak tersedia untuk kejadian ini.</div>'; body=box("WILAYAH YANG MERASAKAN",'<div style="font-size:10px;line-height:1.5">' + felt + '</div>')+box("SHAKEMAP / INTENSITAS GUNCANGAN",sm)+box("CATATAN",'<div style="font-size:10px;line-height:1.5">Dampak lokal dapat berbeda dari magnitudo. Informasi hanya ditampilkan jika disediakan sumber.</div>'); }
  else if(isTs && page===2){ const instr=[q.instruction,q.instruction1,q.instruction2,q.instruction3].filter(Boolean).join("\n")||"Pantau buletin resmi BMKG/InaTEWS. Jika merasakan gempa kuat atau lama di wilayah pesisir, segera menjauh dari pantai menuju tempat lebih tinggi dan ikuti petugas. Jangan menunggu sirene."; body=box("ARAHAN / INSTRUKSI KESELAMATAN",'<div style="font-size:10px;line-height:1.55;white-space:pre-line">' + esc(instr) + '</div>')+box("LANGKAH AMAN",'<div style="font-size:10px;line-height:1.6">• Ikuti arahan BPBD dan petugas setempat.<br>• Jangan mendekati pantai untuk melihat kondisi laut.<br>• Bila peringatan aktif, bergerak ke tempat tinggi/jauh dari pantai tanpa menunggu.</div>'); }
  else if(isTs && page===3){ const chunk=zones; const list=chunk.map(z=>'<div style="display:flex;gap:7px;padding:7px 0;border-bottom:1px solid #e2e8f0"><b style="font-size:9px;padding:3px 4px;border-radius:4px;min-width:50px;text-align:center;background:'+(z.level==="awas"?"#fee2e2":z.level==="siaga"?"#ffedd5":"#fef9c3")+'">' + esc(String(z.level||"waspada").toUpperCase()) + '</b><div style="flex:1;font-size:10px;font-weight:700;overflow-wrap:anywhere">' + esc(z.name) + '<div style="font-size:9px;font-weight:400;color:#64748b">ETA: ' + esc(z.eta||"—") + ' · Tinggi: ' + (z.height==null?"belum tersedia":Number(z.height).toFixed(2)+" m") + '</div></div></div>').join(""); body=box("DAFTAR WILAYAH PERINGATAN TSUNAMI",'<div style="font-size:9px;line-height:1.4;margin-bottom:6px">Daftar sesuai buletin sumber. Level/ETA/tinggi tidak diada-adakan.</div>'+(list||'<div style="font-size:10px;line-height:1.5">Daftar wilayah terstruktur tidak tersedia pada buletin ini. Periksa peta zona dan buletin resmi terbaru.</div>'))+box("PENTING",'<div style="font-size:9px;line-height:1.45">Zona dan status dapat berubah pada buletin berikutnya. Ikuti arahan resmi.</div>'); }
  else if(isTs && page===4){
    // Halaman kelima khusus peta tinggi gelombang dan estimasi waktu tiba.
    // ShakeMap tidak diulang di halaman ini; peta dijaga utuh agar tidak terpotong.
    const tsunamiMaps = [
      {label:"Ketinggian gelombang / SSHmax",url:q.sshmap},
      {label:"Estimasi waktu tiba tsunami",url:q.ttmap}
    ].filter(m=>m.url);
    const imgs = tsunamiMaps.map(m =>
      '<section style="margin:7px 0;padding:7px;background:#fff;border:1px solid #dbe3ee;border-radius:7px;break-inside:avoid">' +
      '<b style="font-size:10px;display:block;margin-bottom:5px;color:#334155">' + esc(m.label) + '</b>' +
      '<div style="width:100%;height:205px;display:flex;align-items:center;justify-content:center;background:#f8fafc;overflow:visible">' +
      '<img src="' + esc(m.url) + '" crossorigin="anonymous" alt="' + esc(m.label) + '" style="display:block;width:100%;height:205px;object-fit:contain;object-position:center;background:#fff">' +
      '</div></section>'
    ).join("");
    body = box("PETA TSUNAMI · TINGGI GELOMBANG & WAKTU TIBA",
      imgs || '<div style="font-size:10px;line-height:1.5">Peta tinggi gelombang (SSHmax) dan/atau estimasi waktu tiba tidak tersedia pada buletin yang diterima. Tidak ada peta yang dibuat-buat.</div>') +
      box("CATATAN",'<div style="font-size:9px;line-height:1.45">Peta ditampilkan sesuai rasio aslinya agar isi peta tetap utuh. Ikuti buletin resmi terbaru.</div>');
  }
  else { const imgs=maps.map(m=>'<div style="margin:7px 0"><b style="font-size:10px;display:block;margin-bottom:3px">' + esc(m.label) + '</b><img src="' + esc(m.url) + '" crossorigin="anonymous" alt="' + esc(m.label) + '" style="width:100%;max-height:155px;object-fit:contain;display:block;background:#fff;border:1px solid #dbe3ee;border-radius:5px"></div>').join(""); body=box("PETA & PRODUK TSUNAMI DARI BULETIN",imgs||'<div style="font-size:10px;line-height:1.5">Peta SSHmax, Warning Zone, atau estimasi waktu tiba tidak disertakan dalam buletin yang diterima.</div>')+box("ARAHAN BMKG",'<div style="font-size:10px;line-height:1.5">Ikuti buletin resmi terbaru dan arahan petugas setempat.</div>'); }
  wrap.innerHTML = '<div style="height:76px;box-sizing:border-box;padding:10px 12px;background:'+(isTs?"linear-gradient(110deg,#7f1d1d,#dc2626)":"linear-gradient(110deg,#0f2742,#155e75)")+' ;color:#fff;display:flex;align-items:center;gap:9px"><div style="width:49px;height:49px;border:2px solid #ffffff88;border-radius:7px;display:grid;place-items:center;font-size:19px;font-weight:900;flex-shrink:0">' + magStr + '</div><div style="min-width:0;flex:1"><div style="font-size:11px;font-weight:900;line-height:1.2">' + esc(title) + '</div><div style="font-size:9px;margin-top:5px;line-height:1.35">' + esc(q.place||"Lokasi belum tersedia") + '<br>' + esc(when) + '</div></div><div style="font-size:9px;font-weight:900;text-align:center;border:1px solid #ffffff80;padding:5px;border-radius:6px">WRS<br>GEMPA</div></div><div style="height:575px;box-sizing:border-box;padding:0 12px;overflow:hidden">' + body + '</div><div style="height:42px;box-sizing:border-box;padding:7px 8px;background:#0f172a;color:#cbd5e1;text-align:center;font-size:8px;line-height:1.4">Sumber data: BMKG / InaTEWS / USGS · WRS Gempa merupakan pemantauan independen, bukan kanal resmi BMKG · ' + (page+1) + '/' + pageCount + '</div>';
  document.body.appendChild(wrap); return wrap;
}
function buildExportPages(q){ const isTs=!!(q.isTsunamiWarning||isTsunamiPotential(q.potential)||/tsunami/i.test(q.subject||"")); const zones=isTs&&typeof parseTsunamiZones==="function"?parseTsunamiZones(q):[]; const defs=[{page:0,label:"ringkasan"},{page:1,label:"dampak-shakemap"}]; if(isTs){defs.push({page:2,label:"arahan-keselamatan"});defs.push({page:3,label:"wilayah-tsunami"});defs.push({page:4,label:"peta-tsunami"});}return defs.map(d=>({...d,count:defs.length}));}
/**
 * Simpan sebagai PNG tajam (kartu terang) + watermark
 */
async function saveModalAsImage(_cardEl, filename) {
  const q = window._modalQuake;
  if (!q) return;
  if (typeof html2canvas !== "function") {
    alert("Library gambar belum termuat. Coba refresh halaman.");
    return;
  }
  const defs = buildExportPages(q);
  const base = (filename || "info-gempa.png").replace(/\.png$/i, "");
  let saved = 0;
  const nativeGallery = !!(window.AndroidWrs && typeof window.AndroidWrs.saveImage === "function");
  showLoading("Membuat " + defs.length + " gambar PNG…");
  try {
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const el = buildExportCard(q, def.page, def.count, def.label);
      try {
        const imgs = [...el.querySelectorAll("img")];
        await Promise.all(imgs.map(img => new Promise(resolve => {
          if (img.complete && img.naturalWidth > 0) return resolve();
          img.onload = resolve; img.onerror = resolve; setTimeout(resolve, 5000);
        })));
        await new Promise(resolve => setTimeout(resolve, 150));
        const canvas = await html2canvas(el, {
          backgroundColor: "#f8fafc", scale: 2, useCORS: true, allowTaint: false,
          logging: false, scrollX: 0, scrollY: 0, width: 390, height: 693,
          windowWidth: 390, windowHeight: 693
        });
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Gagal membuat gambar halaman " + (i + 1));
        const pageName = base + "_" + String(i + 1).padStart(2, "0") + "_" + def.label + ".png";
        if (nativeGallery) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const result = window.AndroidWrs.saveImage(pageName, dataUrl.split(",")[1] || "");
          if (result !== "OK") throw new Error(result || "Gagal menyimpan ke galeri");
        } else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url; link.download = pageName;
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        saved++;
        showLoading("Menyimpan PNG " + saved + " dari " + defs.length + "…");
      } finally { el.remove(); }
    }
    if (nativeGallery) alert("Berhasil! " + saved + " gambar PNG tersimpan di Galeri > Album WRS GEMPA.");
    else alert("Berhasil menyiapkan " + saved + " gambar PNG satu per satu. Jika browser meminta izin unduhan, izinkan.");
  } catch (err) {
    console.warn("Penyimpanan gambar PNG gagal:", err);
    alert("Gagal menyimpan gambar. " + saved + " dari " + defs.length + " berhasil. " + (err?.message || "Coba refresh halaman lalu ulangi."));
  } finally { hideLoading(); }
}
$("#btnShare")?.addEventListener("click", () => shareQuake(window._modalQuake));
$("#btnShareTsunami")?.addEventListener("click", () => shareQuake(window._modalQuake));

$("#btnSave")?.addEventListener("click", () => {
  const q = window._modalQuake;
  if (!q) return;
  const card = $("#modalDetail")?.querySelector(".modal-card");
  const name = `gempa_M${q.magnitude.toFixed(1)}_${String(q.time).slice(0, 10)}.png`;
  saveModalAsImage(card, name);
});

$("#btnSaveTsunami")?.addEventListener("click", () => {
  const q = window._modalQuake;
  if (!q) return;
  const card = $("#tsunamiCard");
  const name = `tsunami_M${q.magnitude.toFixed(1)}_${String(q.time).slice(0, 10)}.png`;
  saveModalAsImage(card, name);
});

/* Toolbar */
$("#tbBasemap").onclick = () => {
  $("#basemapMenu").classList.toggle("hidden");
};
document.querySelectorAll(".bm-opt").forEach((btn) => {
  btn.onclick = () => {
    setBasemap(btn.dataset.bm);
    $("#basemapMenu").classList.add("hidden");
  };
});
$("#tbFullscreen").onclick = async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
      document.body.classList.add("monitoring-mode");
      $("#tbFullscreen").setAttribute("aria-pressed", "true");
      $("#tbFullscreen").title = "Keluar dari mode monitoring";
    } else {
      await document.exitFullscreen?.();
    }
  } catch (error) {
    // Fullscreen may be blocked by the browser; retain a useful CSS-only mode.
    document.body.classList.toggle("monitoring-mode");
  }
};
document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  document.body.classList.toggle("monitoring-mode", active);
  $("#tbFullscreen")?.setAttribute("aria-pressed", String(active));
  if (!active && $("#tbFullscreen")) $("#tbFullscreen").title = "Layar penuh";
  setTimeout(() => {
    try { map?.invalidateSize({ animate: false }); miniMap?.invalidateSize({ animate: false }); }
    catch (error) { console.warn("Map resize after fullscreen change failed", error); }
  }, 150);
});
$("#tbRefresh").onclick = () => {
  $("#liveText").textContent = "REFRESH…";
  load(true);
};
$("#tbHistory").onclick = () => openHistory("all");
$("#tbLocation")?.addEventListener("click", () => activateLocation(true));
$("#btnLocation")?.addEventListener("click", () => activateLocation(true));
document.querySelectorAll(".stat-btn").forEach((btn) => {
  btn.addEventListener("click", () => openHistory(btn.dataset.stat || "all"));
});
// Restore location cache on load
try {
  const cached = JSON.parse(localStorage.getItem("wrsUserLoc") || "null");
  if (cached?.lat) {
    userLocation = cached;
    setLocStatus(true, `Lokasi · ${cached.lat.toFixed(3)}°, ${cached.lon.toFixed(3)}°`);
    setTimeout(() => updateUserMarker(false), 800);
  }
} catch {}
$("#tbFaults").onclick = () => {
  faultsVisible = !faultsVisible;
  if (faultsVisible) {
    map.addLayer(faultLayer);
    $("#tbFaults").dataset.on = "1";
  } else {
    map.removeLayer(faultLayer);
    $("#tbFaults").dataset.on = "0";
  }
};

/* Advanced monitoring filter */
function syncFilterUI() {
  $("#filterMag").value = String(filterState.mag);
  $("#filterAge").value = String(filterState.age);
  $("#filterSource").value = filterState.source;
  $("#filterDepth").value = filterState.depth;
}
$("#tbFilter")?.addEventListener("click", () => {
  syncFilterUI();
  $("#filterModal")?.classList.remove("hidden");
});
$("#filterClose")?.addEventListener("click", () => $("#filterModal")?.classList.add("hidden"));
$("#filterModal")?.addEventListener("click", (e) => { if (e.target === $("#filterModal")) $("#filterModal").classList.add("hidden"); });
$("#filterReset")?.addEventListener("click", () => {
  filterState = { mag: 1.5, age: 168, source: "ALL", depth: "ALL" };
  localStorage.setItem("wrsFilterV1", JSON.stringify(filterState));
  syncFilterUI(); drawMarkers(true);
});
$("#filterApply")?.addEventListener("click", () => {
  filterState = {
    mag: Number($("#filterMag").value), age: Number($("#filterAge").value),
    source: $("#filterSource").value, depth: $("#filterDepth").value
  };
  localStorage.setItem("wrsFilterV1", JSON.stringify(filterState));
  drawMarkers(true);
  $("#filterModal").classList.add("hidden");
});

/* Push */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function setupPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    $("#pushStatus").textContent = "Browser ini tidak mendukung notifikasi latar belakang";
    $("#btnPush").disabled = true;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      $("#btnPush")?.classList.add("on");
      $("#pushStatus").textContent = "Langganan perangkat ditemukan · pengiriman server belum diverifikasi";
    }
  } catch (e) {
    console.error("SW register gagal", e);
  }
}

window.onNativeWrsAlertsEnabled = (enabled) => {
  const button = $("#btnPush");
  const status = $("#pushStatus");
  if (button) button.classList.toggle("on", !!enabled);
  if (status) status.textContent = enabled
    ? "Notif · aktif (Android/FCM)"
    : "Izin notifikasi belum diberikan — cek Setelan Android";
  if (enabled) localStorage.setItem("wrsPushEnabled", "1");
  else localStorage.removeItem("wrsPushEnabled");
};

$("#btnPush").onclick = async () => {
  // In the Android wrapper, use native FCM instead of Web Push/Netlify.
  // The web deployment is on Cloudflare Pages, so a Netlify subscription
  // endpoint may not exist on this origin.
  if (window.AndroidWrs && typeof window.AndroidWrs.enableAlerts === "function") {
    $("#pushStatus").textContent = "Meminta izin notifikasi Android…";
    try {
      window.AndroidWrs.enableAlerts();
    } catch (error) {
      console.error("Native alert setup failed", error);
      $("#pushStatus").textContent = "Gagal mengaktifkan notifikasi Android";
      $("#btnPush")?.classList.remove("on");
    }
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    $("#pushStatus").textContent = "Browser ini tidak mendukung Push API";
    return;
  }
  try {
    // 1) Izin notifikasi
    let perm = Notification.permission;
    if (perm !== "granted") {
      perm = await Notification.requestPermission();
    }
    if (perm !== "granted") {
      $("#pushStatus").textContent = "Izin notifikasi ditolak — buka Setelan browser → Izinkan notifikasi untuk situs ini";
      return;
    }

    // 2) Service worker
    let reg;
    try {
      reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    } catch (swErr) {
      console.error(swErr);
      $("#pushStatus").textContent = "Service Worker gagal. Periksa izin browser dan coba lagi; layanan push server belum diverifikasi.";
      return;
    }

    // 3) Ambil kunci server, lalu pastikan subscription memakai kunci yang sama.
    let vapidPublicKey;
    try {
      const keyResponse = await fetch("/api/push-key", { cache: "no-store" });
      const keyData = await keyResponse.json();
      if (!keyResponse.ok || !keyData.publicKey) throw new Error("Kunci push server belum tersedia");
      vapidPublicKey = keyData.publicKey;
    } catch (keyErr) {
      console.warn(keyErr);
      $("#pushStatus").textContent = "Kunci notifikasi server belum siap. Coba lagi sebentar.";
      return;
    }

    const expectedKey = urlBase64ToUint8Array(vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const currentKey = sub.options?.applicationServerKey;
      const currentBytes = currentKey ? new Uint8Array(currentKey) : new Uint8Array();
      const sameKey = currentBytes.length === expectedKey.length &&
        currentBytes.every((byte, index) => byte === expectedKey[index]);
      if (!sameKey) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: expectedKey,
        });
      } catch (subErr) {
        console.error(subErr);
        $("#pushStatus").textContent =
          "Gagal subscribe push — coba refresh, pastikan izin notifikasi ON, dan domain HTTPS.";
        return;
      }
    }

    // 4) Simpan subscription ke Cloudflare Pages Function + KV
    let serverOk = false;
    try {
      const res = await fetch(SUBSCRIBE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });
      if (res.ok) {
        serverOk = true;
      } else {
        const t = await res.text().catch(() => "");
        console.warn("subscribe status", res.status, t);
        $("#pushStatus").textContent =
          res.status === 500
            ? "Server error — endpoint push belum dikonfigurasi di deployment ini"
            : `Gagal simpan subscription (HTTP ${res.status}). Periksa konfigurasi layanan push untuk situs ini.`;
      }
    } catch (netErr) {
      console.warn(netErr);
      $("#pushStatus").textContent =
        "Endpoint langganan push belum terhubung di situs ini.";
    }

    // 5) Notifikasi lokal tetap diuji (meski server gagal)
    try {
      await reg.showNotification("Notifikasi aktif", {
        body: serverOk
          ? "Langganan push tersimpan. Pengiriman latar belakang mengikuti status layanan WRS GEMPA."
          : "Izin perangkat aktif, tetapi langganan push belum tersimpan di server.",
        icon: "/icons/icon-192.png",
        tag: "wrs-test",
      });
    } catch {
      try {
        new Notification("Notifikasi aktif", {
          body: "Izin notifikasi OK di browser ini.",
          icon: "/icons/icon-192.png",
        });
      } catch {}
    }

    if (serverOk) {
      $("#btnPush")?.classList.add("on");
      $("#pushStatus").textContent = "Push tersimpan · pengiriman belum diuji";
    } else {
      $("#btnPush")?.classList.add("on");
      // pesan server sudah diisi di atas jika gagal
      if (!$("#pushStatus").textContent.startsWith("Notif") && !$("#pushStatus").textContent.includes("Server") && !$("#pushStatus").textContent.includes("Gagal") && !$("#pushStatus").textContent.includes("Functions")) {
        $("#pushStatus").textContent = "Izin lokal OK · push server belum siap";
      }
    }
  } catch (e) {
    console.error("Push subscribe gagal", e);
    const msg = String(e?.message || e);
    if (/vapid|applicationServerKey/i.test(msg)) {
      $("#pushStatus").textContent = "VAPID key tidak cocok — periksa pasangan VAPID public/private key pada layanan push.";
    } else {
      $("#pushStatus").textContent = "Gagal: " + msg.slice(0, 120);
    }
  }
};

/* External links: show brief loading feedback */
document.querySelectorAll("a.ext-link").forEach((a) => {
  a.addEventListener("click", () => {
    a.classList.add("ext-loading");
    showLoading("Membuka tautan…");
    setTimeout(() => {
      hideLoading();
      a.classList.remove("ext-loading");
    }, 900);
  });
});

setupPush();
initMap();
load(true);
// Jika halaman dibuka dari tautan Bagikan WRS, fokuskan titiknya lalu buka detail event
// setelah katalog selesai dimuat. Parameter event cocok dengan key event stabil.
function openSharedEventFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const eventKey = params.get("event");
  const lat = Number(params.get("lat")), lon = Number(params.get("lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    try { map?.setView([lat, lon], 7, { animate: false }); } catch {}
  }
  if (!eventKey) return;
  const found = quakes.find(item => String(item.key) === eventKey);
  if (found) openModal(found);
  else {
    const retry = () => {
      const match = quakes.find(item => String(item.key) === eventKey);
      if (match) { clearInterval(timer); openModal(match); }
    };
    const timer = setInterval(retry, 1000);
    setTimeout(() => clearInterval(timer), 20000);
  }
}
setTimeout(openSharedEventFromUrl, 1200);
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const retryDelay = consecutiveLoadFailures > 0
    ? Math.min(30000, 2000 * (2 ** Math.min(consecutiveLoadFailures - 1, 4)))
    : currentInterval();
  refreshTimer = setTimeout(async () => {
    await load(false);
    scheduleRefresh();
  }, retryDelay);
}
updateModeButtons();
if (wrsMode === "simulation") applySimulationMode();
scheduleRefresh();
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const primary = primaryRealtimeQuake();
  if (primary) $("#rtAgo").textContent = timeAgo(primary);
}, 1000);

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

// Unlock audio on first user gesture (mobile) — keep listening a few times
function unlockAudioOnce() {
  ensureAudio().catch(() => {});
  if ("speechSynthesis" in window) {
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
  }
}
["click", "touchstart", "pointerdown"].forEach((ev) => {
  document.addEventListener(ev, unlockAudioOnce, { passive: true, once: true });
});

/* ===== Mobile bottom sheet: nyaman di HP ===== */
function isMobileLayout() {
  return window.matchMedia && window.matchMedia("(max-width:900px)").matches;
}

function setSheetCollapsed(collapsed) {
  const panel = $("#rightPanel");
  if (!panel) return;
  panel.classList.toggle("sheet-collapsed", !!collapsed);
  document.body.classList.toggle("sheet-collapsed", !!collapsed);
  document.body.classList.toggle("sheet-open", !collapsed);
  setTimeout(() => {
    try {
      map?.invalidateSize({ animate: false });
    } catch {}
  }, 320);
}

function initMobileSheet() {
  const panel = $("#rightPanel");
  const handle = $("#rpSheetToggle");
  if (!panel) return;

  // Default di HP: sheet collaps biar peta lega
  if (isMobileLayout()) setSheetCollapsed(true);
  else {
    panel.classList.remove("sheet-collapsed");
    document.body.classList.remove("sheet-collapsed", "sheet-open");
  }

  handle?.addEventListener("click", () => {
    if (!isMobileLayout()) return;
    setSheetCollapsed(!panel.classList.contains("sheet-collapsed"));
  });

  // Tap bar magnitudo juga toggle di HP
  panel.querySelector(".rp-mag-bar")?.addEventListener("click", (e) => {
    if (!isMobileLayout()) return;
    if (e.target.closest("a,button,input,label")) return;
    setSheetCollapsed(!panel.classList.contains("sheet-collapsed"));
  });

  window.addEventListener(
    "resize",
    () => {
      if (!isMobileLayout()) {
        panel.classList.remove("sheet-collapsed");
        document.body.classList.remove("sheet-collapsed", "sheet-open");
      }
      try {
        map?.invalidateSize({ animate: false });
      } catch {}
    },
    { passive: true }
  );

  // Jeda polling saat tab tidak terlihat agar browser tidak bekerja di belakang layar.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(refreshTimer);
    } else {
      load(false);
      scheduleRefresh();
      try {
        map?.invalidateSize({ animate: false });
      } catch {}
    }
  });
}

initMobileSheet();

// Mobile page visibility can change Leaflet container dimensions. Recalculate both maps
// after navigation so the mini earthquake map does not render as an empty rectangle.
window.addEventListener("wrs:mobile-page-shown", () => {
  window.setTimeout(() => {
    try {
      if (map) map.invalidateSize({ animate: false });
      if (miniMap) {
        miniMap.invalidateSize({ animate: false });
        if (currentOfficial && Number.isFinite(currentOfficial.lat) && Number.isFinite(currentOfficial.lon)) {
          miniMap.setView([currentOfficial.lat, currentOfficial.lon], 6, { animate: false });
        }
      }
    } catch (error) {
      console.warn("Map resize after mobile navigation failed", error);
    }
  }, 180);
});
