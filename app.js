const API = "/api/earthquakes";
const SUBSCRIBE_API = "/.netlify/functions/subscribe";
const VAPID_PUBLIC_KEY =
  "BMMLWEJGdS_HeyHwUWt9z6iswzec3RzLIXGWIrLmLa7xptYq4oLYFLiYlR-g0XE7rZJ4PFieSK9NRf-tOtKRmAA";
const NORMAL_INTERVAL = 15000;
const currentInterval = () => NORMAL_INTERVAL;
const SHAKEMAP_BASE = "https://bmkg-content-inatews.storage.googleapis.com/";
const $ = (s) => document.querySelector(s);

let map, markers, miniMap, miniMarker, faultLayer, radiusLayer, latestStarLayer, baseLayer, histMap;
let userMarker = null;
let quakes = [];
/** Riwayat peringatan dini tsunami dari InaTEWS (last30tsunamievent.xml) */
let tsunamiHistory = [];
let alarmOn = false;
let audioCtx = null;
let firstLoad = true;
let currentOfficial = null;
let faultsVisible = true;
let filterState = JSON.parse(localStorage.getItem("wrsFilterV1") || "null") || { mag: 1.5, age: 168, source: "ALL", depth: "ALL" };
let lastRenderFingerprint = "";
let loadInFlight = false;
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
    const p = String(coord).split(",").map((x) => num(x.trim()));
    if (p.length >= 2) { lat = p[0]; lon = p[1]; }
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
      const r = await fetch(url + "?t=" + Date.now(), { headers: UA, cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const g = j?.Infogempa?.gempa;
      if (Array.isArray(g)) g.forEach((x) => { const n = normPublic(x); if (n) pub.push(n); });
      else if (g) { const n = normPublic(g); if (n) pub.push(n); }
    } catch { /* skip */ }
  }));

  let ql = [];
  try {
    const r = await fetch("https://bmkg-content-inatews.storage.googleapis.com/gempaQL.json?t=" + Date.now(), { headers: UA, cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      ql = (j.features || []).map(normQL).filter(Boolean);
    }
  } catch { /* skip */ }

  // Global USGS feed: keep Indonesia-first BMKG/InaTEWS data, plus worldwide M5+
  // events and events flagged by USGS as tsunami-related.
  let usgs = [];
  try {
    const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson?t=" + Date.now(), { headers: UA, cache: "no-store" });
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
  const all = [...pub, ...ql, ...usgs].sort((a, b) => new Date(b.time) - new Date(a.time));
  for (const q of all) {
    if (byKey.has(q.key)) continue;
    const s = `${q.magnitude.toFixed(1)}|${(q.place || "").slice(0, 30)}|${String(q.time).slice(0, 16)}`;
    if (sig.has(s)) continue;
    byKey.set(q.key, q);
    sig.add(s);
  }
  const recent = [...byKey.values()].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 600);
  const official = pub.filter((q) => q.official).sort((a, b) => new Date(b.time) - new Date(a.time));
  return {
    ok: true, recent,
    official: official[0] || recent.find((q) => q.official) || recent[0] || null,
    count: recent.length,
    sources: { client: true, public: pub.length, inaQL: ql.length },
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
  const latestKey = list[0]?.key;
  list.slice(0, 800).forEach((q) => {
    const latest = q.key === latestKey;
    const fill = magColor(q.magnitude);
    const edge = depthColor(q.depth);
    const size = radius(q.magnitude);

    const marker = L.circleMarker([q.lat, q.lon], {
      radius: size,
      color: latest ? "#ffffff" : edge,
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

function showRealtimeUpdate(info) {
  const el = $("#rtUpdate");
  if (!el) return;
  if (!info || !info.parts?.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const tag = info.significant ? "REVISI BESAR" : "PEMUTAKHIRAN";
  el.classList.remove("hidden");
  el.classList.toggle("rev-big", !!info.significant);
  el.innerHTML =
    `<span class="rt-upd-tag">${tag}</span> ` +
    `<span class="rt-upd-txt">${info.parts.join(" · ")}</span>`;
  lastRevisionInfo = info;
  // Auto-sembunyikan label lembut setelah 2 menit (data tetap di cache)
  clearTimeout(showRealtimeUpdate._t);
  showRealtimeUpdate._t = setTimeout(() => {
    if (!info.significant) el.classList.add("hidden");
  }, 120000);
}

function renderRealtime(q) {
  if (!q) return;
  const el = $("#rtMag");
  el.textContent = q.magnitude.toFixed(1);
  el.style.background = `linear-gradient(145deg, ${magColor(q.magnitude)}55, #0d2038)`;
  el.style.borderColor = magColor(q.magnitude);
  el.style.color = q.magnitude >= 5 ? "#fecaca" : "#7ef9ff";
  $("#rtDate").textContent = shortDate(q);
  $("#rtAgo").textContent = timeAgo(q);
  $("#rtCoord").textContent = `◎ ${fmtCoord(q)} · ${q.depth} Km`;
  $("#rtPlace").textContent = q.place;
  $("#rtSrc").textContent = `Sumber: ${q.source || "BMKG"}`;
  // Tampilkan badge revisi jika event yang sama baru di-update
  if (lastRevisionInfo && lastRevisionInfo.id === stableEventId(q)) {
    showRealtimeUpdate(lastRevisionInfo);
  } else if (!lastRevisionInfo || lastRevisionInfo.id !== stableEventId(q)) {
    const elUp = $("#rtUpdate");
    if (elUp && !lastRevisionInfo) elUp.classList.add("hidden");
  }
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

function renderOfficial(q) {
  if (!q) return;
  currentOfficial = q;
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

  const pot = q.potential && q.potential !== "—"
    ? q.potential
    : q.felt ? "Gempa ini dirasakan untuk diteruskan pada masyarakat" : "Tidak ada potensi tsunami";
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

  $("#offInstr span").textContent =
    q.instruction || "Hati-hati terhadap gempabumi susulan yang mungkin terjadi";

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
  if (q.shakemap && !forceFallback) return;
  const box = ensureUsgsProductsBox();
  if (!box) return;
  const isUsgsEvent = q.source === "USGS" || String(q.key || "").startsWith("usgs|");
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
    const shake = getPreferredUsgsProduct(products.shakemap);
    const contents = shake?.contents || {};
    const entries = Object.entries(contents).filter(([, item]) => item?.url);
    // USGS product paths may include download/ and newer names such as psa3p0.jpg.
    // Select only the MMI intensity map for the main detail view, not other technical maps.
    const normPath = path => String(path || "").replace(/^.*\/download\//i, "").replace(/^\/+/, "");
    const mmiEntry = entries.find(([path]) => /^(?:intensity|mmi)\.(?:jpg|jpeg|png)$/i.test(normPath(path)))
      || entries.find(([path]) => /^(?:ii_thumbnail|pin-thumbnail)\.(?:jpg|jpeg|png)$/i.test(normPath(path)));
    let html = '<div style="font-weight:900;font-size:16px;margin-bottom:8px">PETA INTENSITAS GUNCANGAN (MMI)</div>';
    if (mmiEntry) {
      const imageUrl = mmiEntry[1].url;
      const sourceName = isUsgsEvent ? "USGS ShakeMap" : "USGS ShakeMap (sumber cadangan; peta BMKG tidak tersedia)";
      html += '<figure style="margin:0"><a href="' + safe(imageUrl) + '" target="_blank" rel="noopener noreferrer"><img src="' + safe(imageUrl) + '" alt="Peta intensitas guncangan MMI" loading="lazy" style="display:block;width:100%;height:auto;max-height:520px;object-fit:contain;background:#fff;border-radius:8px" onerror="this.closest(\'figure\')?.classList.add(\'hidden\')"></a></figure>';
      html += '<div style="font-size:11px;line-height:1.45;opacity:.72;margin-top:7px">Sumber peta: ' + sourceName + '. Peta merupakan estimasi ilmiah, bukan pengukuran pasti di setiap lokasi.</div>';
    } else {
      // Fallback to a ShakeMap URL even when the product's content key is oddly named.
      const fallback = entries.find(([path, item]) => /\.(?:jpg|jpeg|png)$/i.test(normPath(path)) && /intensity|mmi/i.test(normPath(path) + " " + (item.contentType || "")));
      if (fallback) {
        const imageUrl = fallback[1].url;
        html += '<figure style="margin:0"><a href="' + safe(imageUrl) + '" target="_blank" rel="noopener noreferrer"><img src="' + safe(imageUrl) + '" alt="Peta intensitas guncangan MMI" loading="lazy" style="display:block;width:100%;height:auto;max-height:520px;object-fit:contain;background:#fff;border-radius:8px" onerror="this.closest(\'figure\')?.classList.add(\'hidden\')"></a></figure>';
        html += '<div style="font-size:11px;line-height:1.45;opacity:.72;margin-top:7px">Sumber peta: USGS ShakeMap. Peta merupakan estimasi ilmiah.</div>';
      } else {
        html += '<div style="padding:10px;border:1px solid var(--border,#cbd5e1);border-radius:9px;font-size:13px">Peta intensitas MMI belum tersedia untuk kejadian ini.</div>';
      }
    }
    // Jangan ulangi koordinat/magnitudo atau daftar tautan produk. Satu tautan sumber
    // ditempatkan tersembunyi di bagian catatan ringkas.
    if (feature) {
      const eventUrl = p.url || ("https://earthquake.usgs.gov/earthquakes/eventpage/" + encodeURIComponent(feature.id || eventId));
      html += '<details style="margin-top:8px;font-size:11px;opacity:.78"><summary style="cursor:pointer">Sumber peta dan detail lainnya</summary><p>Gambar MMI dari USGS ShakeMap untuk kejadian yang dicocokkan berdasarkan waktu dan lokasi.</p><a href="' + safe(eventUrl) + '" target="_blank" rel="noopener noreferrer">Sumber USGS ↗</a></details>';
    }
    box.innerHTML = html;
  } catch (error) {
    if (window._modalQuake?.key !== q.key) return;
    box.innerHTML = '<div style="font-weight:900;font-size:16px;margin-bottom:8px">PETA INTENSITAS GUNCANGAN (MMI)</div><p style="font-size:13px">Peta MMI belum tersedia atau sumber cadangan sedang tidak dapat diakses.</p>';
    console.warn("Gagal memuat peta MMI cadangan USGS", error);
  }
}
