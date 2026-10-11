const API = "/.netlify/functions/earthquakes";
const SUBSCRIBE_API = "/.netlify/functions/subscribe";
const VAPID_PUBLIC_KEY =
  "BMMLWEJGdS_HeyHwUWt9z6iswzec3RzLIXGWIrLmLa7xptYq4oLYFLiYlR-g0XE7rZJ4PFieSK9NRf-tOtKRmAA";
const NORMAL_INTERVAL = 10000;
let batterySaver = localStorage.getItem("wrsBatterySaverV1") === "1";
const currentInterval = () => batterySaver ? 60000 : NORMAL_INTERVAL;
const SHAKEMAP_BASE = "https://bmkg-content-inatews.storage.googleapis.com/";
const $ = (s) => document.querySelector(s);

let map, markers, miniMap, miniMarker, faultLayer, radiusLayer, baseLayer, histMap;
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
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attr: "© OSM · © CARTO",
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

  const byKey = new Map();
  const sig = new Set();
  const all = [...pub, ...ql].sort((a, b) => new Date(b.time) - new Date(a.time));
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
  const bm = BASEMAPS[key] || BASEMAPS.dark;
  baseLayer = L.tileLayer(bm.url, { maxZoom: 12, attribution: bm.attr }).addTo(map);
  document.querySelectorAll(".bm-opt").forEach((b) => b.classList.toggle("active", b.dataset.bm === key));
  localStorage.setItem("wrsBasemap", key);
}

function initMap() {
  // Canvas dipakai untuk marker agar pan/zoom tetap ringan. Sesar dibuat static sederhana.
  map = L.map("map", { zoomControl: true, preferCanvas: true, renderer: L.canvas({ padding: 0.5 }) }).setView([-3.5, 118], 5);
  const saved = localStorage.getItem("wrsBasemap") || "dark";
  setBasemap(saved);

  const clusterOptions = {
    chunkedLoading: true,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    maxClusterRadius: 42,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const level = count >= 100 ? "xl" : count >= 25 ? "lg" : "md";
      return L.divIcon({
        className: "quake-cluster-wrap",
        html: '<span class="quake-cluster ' + level + '">' + (count > 999 ? "999+" : count) + '</span>',
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      });
    }
  };
  markers = (typeof L.markerClusterGroup === "function"
    ? L.markerClusterGroup(clusterOptions)
    : L.layerGroup()).addTo(map);
  // Radius/pulse rings are intentionally disabled for a cleaner, low-distraction map.
  radiusLayer = L.layerGroup().addTo(map);

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
  L.tileLayer(BASEMAPS.dark.url, { maxZoom: 10 }).addTo(miniMap);
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
  return /tsunami|berpotensi|awas|siaga|waspada/i.test(s) && !/tidak\s*(ada\s*)?berpotensi|tidak\s*ada\s*potensi|tidak ada potensi/i.test(s);
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
  // Avoid recreating hundreds of objects when only the clock/side panel changes.
  const fp = `${filterState.mag}|${filterState.age}|${filterState.source}|${filterState.depth}|${list.map(q => q.key).join(",")}`;
  if (!force && fp === lastRenderFingerprint) return;
  lastRenderFingerprint = fp;
  markers.clearLayers();

  // Crisp diamond markers: magnitude controls size/color; depth controls border color.
  // Cluster nearby events to keep dense areas readable on mobile.
  const latestKey = list[0]?.key;
  list.slice(0, 800).forEach((q) => {
    const latest = q.key === latestKey;
    const fill = magColor(q.magnitude);
    const edge = depthColor(q.depth);
    const size = latest ? 18 : Math.max(9, Math.min(16, Math.round(7 + Number(q.magnitude || 0) * 1.25)));
    const icon = L.divIcon({
      className: "quake-marker-wrap",
      html: '<span class="quake-diamond' + (latest ? ' is-latest' : '') + '" style="--quake-fill:' + fill + ';--quake-edge:' + edge + ';--quake-size:' + size + 'px" aria-hidden="true"></span>',
      iconSize: [size + 8, size + 8],
      iconAnchor: [(size + 8) / 2, (size + 8) / 2]
    });
    const marker = L.marker([q.lat, q.lon], {
      icon,
      keyboard: true,
      title: (latest ? "Gempa terbaru · " : "Gempa · ") + "M" + Number(q.magnitude).toFixed(1),
      zIndexOffset: latest ? 1000 : 0
    });
    marker.bindTooltip(
      '<b>M' + Number(q.magnitude).toFixed(1) + '</b> · kedalaman ' + q.depth + ' km<br><span style="opacity:.85">' + (q.place || "") + '</span>',
      { sticky: true, opacity: 0.96 }
    );
    marker.on("click", () => openModal(q));
    marker.addTo(markers);
  });
  // Pin lokasi user tetap di atas layer marker
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

function openModal(q) {
  if (!q) return;
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

  const pot = q.potential && q.potential !== "—"
    ? q.potential
    : "tidak ada potensi TSUNAMI";
  const tsEl = $("#modalTsunami");
  $("#modalTsunamiText").textContent = pot;
  if (isTsunamiPotential(pot)) tsEl.classList.remove("safe");
  else tsEl.classList.add("safe");

  $("#modalInstrText").textContent =
    q.instruction || "Waspadai kemungkinan gempa susulan.";

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
    smImg.src = q.shakemap;
    smBox.classList.remove("hidden");
  } else {
    smBox.classList.add("hidden");
    smImg.removeAttribute("src");
  }

  window._modalQuake = q;
  $("#modalDetail").classList.remove("hidden");
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
  const q = quakes[0];
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
    if (quakes[0]) updatePopupDistance(quakes[0]);
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
    localStorage.setItem("wrsSeenV8", JSON.stringify([...seen].slice(-1000)));
    saveParamCache();
    firstLoad = false;
    return;
  }

  // Deteksi revisi parameter pada event yang sudah dikenal (prioritas gempa realtime terbaru)
  const top = quakes[0];
  if (top) {
    const rev = detectRevision(top);
    if (rev) {
      showRealtimeUpdate(rev);
      renderRealtime(top);
      saveParamCache();
      // Alarm hanya untuk revisi signifikan (bukan setiap update kecil)
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
                `Pemutakhiran parameter gempa. Magnitudo sekarang ${rev.next.magnitude
                  .toFixed(1)
                  .replace(".", ",")}, kedalaman ${rev.next.depth} kilometer.`
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
  }

  // Seed cache untuk event lain (tanpa notif)
  quakes.slice(0, 80).forEach((q) => {
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
  if (Number.isFinite(q.lat)) map.flyTo([q.lat, q.lon], 7, { duration: 0.6 });

  if (isTsunamiPotential(q.potential)) {
    openTsunamiModal(q);
  }

  if (alarmOn) {
    ensureAudio().then(() => playAlarmSequence(q)).catch(() => {});
  }
}

function status(ok, text) {
  $("#liveDot").className = ok ? "ok" : "bad";
  $("#liveText").textContent = text;
}

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

async function load(showSpin) {
  if (loadInFlight) return;
  loadInFlight = true;
  if (showSpin) showLoading("Memuat data gempa…");
  try {
    let d = null;
    try {
      const r = await fetch(API + "?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) d = await r.json();
    } catch { /* function offline */ }

    if (!d || !d.recent || !d.recent.length) {
      d = await fetchClientSide();
    }

    const incoming = d.recent || [];
    const oldFingerprint = quakes.map(q => q.key + ":" + q.magnitude).join("|");
    quakes = incoming;
    if (Array.isArray(d.tsunamiHistory)) tsunamiHistory = d.tsunamiHistory;
    const newFingerprint = quakes.map(q => q.key + ":" + q.magnitude).join("|");
    status(true, d.sources?.client ? "LIVE · client" : "LIVE");
    const healthText = $("#wrsHealthText");
    const healthTime = $("#wrsLastUpdated");
    const health = $("#wrsHealth");
    if (healthText) healthText.textContent = d.sources?.client ? "DATA AKTIF · SUMBER CADANGAN" : "DATA AKTIF";
    if (healthTime) healthTime.textContent = "Diperbarui " + new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (health) { health.classList.remove("is-error"); health.title = "Pembaruan data berhasil"; }
    const s = d.sources || {};
    $("#srcCount").textContent = `· ${d.count || 0} event` + (s.inaQL != null ? ` (QL ${s.inaQL})` : "") + (s.tsunami != null ? ` · TS ${s.tsunami}` : "");

    if (quakes[0]) renderRealtime(quakes[0]);
    const off = d.official || quakes.find((q) => q.official) || quakes[0];
    if (off) renderOfficial(off);

    if (oldFingerprint !== newFingerprint || showSpin) drawMarkers(true);
    else updateStats(getFilteredQuakes());
    processNew();

    // Push deep link: resolve the exact event after fresh data has arrived.
    const params = new URLSearchParams(window.location.search);
    const requestedKey = params.get("quake");
    if (requestedKey && !window.__wrsHandledQuakeDeepLink) {
      const target = quakes.find((q) => String(q.key || "") === requestedKey);
      if (target) {
        window.__wrsHandledQuakeDeepLink = true;
        if (Number.isFinite(target.lat) && Number.isFinite(target.lon)) map?.flyTo([target.lat, target.lon], 8, { duration: 0.8 });
        openModal(target);
      }
    }
  } catch (e) {
    console.error(e);
    status(false, "OFFLINE");
    const healthText = $("#wrsHealthText");
    const health = $("#wrsHealth");
    if (healthText) healthText.textContent = "DATA TIDAK TERSEDIA";
    if (health) { health.classList.add("is-error"); health.title = "Pembaruan gagal; data terakhir mungkin sudah lama"; }
  } finally {
    loadInFlight = false;
    hideLoading();
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
        ? "<th>M</th><th>Waktu</th><th>Peringatan / Wilayah</th><th>Kedalaman</th>"
        : "<th>M</th><th>Waktu</th><th>Wilayah</th><th>Kedalaman</th>";
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
    body.appendChild(tr);
  });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8">${
      mode === "tsunami"
        ? "Belum ada data buletin tsunami. Pastikan Functions Netlify ter-deploy."
        : "Tidak ada data untuk kategori ini."
    }</td></tr>`;
  }

  $("#modalHistory").classList.remove("hidden");
  setTimeout(() => {
    if (!histMap) {
      histMap = L.map("histMap", { zoomControl: false, attributionControl: false }).setView([-3.5, 118], 4);
      L.tileLayer(BASEMAPS.dark.url, { maxZoom: 10 }).addTo(histMap);
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
          color: isTsunamiPotential(q.potential) ? "#fecaca" : "#fff",
          fillColor: isTsunamiPotential(q.potential) ? "#dc2626" : depthColor(q.depth),
          fillOpacity: 0.85,
          weight: 1.5,
        })
          .addTo(histMap)
          .on("click", () => openModal(q));
      });
  }, 100);
}

/* Events */
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

function buildShareText(q) {
  return `Gempa M${q.magnitude.toFixed(1)} — ${q.place}\nWaktu: ${fmtTime(q)}\nKoordinat: ${fmtCoord(q)}\nKedalaman: ${q.depth} km\nPotensi: ${q.potential || "—"}\nSumber: ${q.source || "BMKG"}\n\nIndependent monitoring by ilham · data resmi BMKG/InaTEWS`;
}

async function shareQuake(q) {
  if (!q) return;
  const text = buildShareText(q);
  if (navigator.share) {
    try { await navigator.share({ title: `Gempa M${q.magnitude.toFixed(1)}`, text }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    alert("Teks info gempa disalin ke clipboard.");
  } catch {
    prompt("Salin teks ini:", text);
  }
}

/**
 * Bangun kartu ekspor terang (mirip BMKG) supaya PNG tidak gelap/buram.
 */
function buildExportCard(q) {
  const wrap = document.createElement("div");
  wrap.id = "exportCard";
  wrap.style.cssText =
    "position:fixed;left:-9999px;top:0;width:520px;background:#f8fafc;color:#0f172a;" +
    "font-family:Segoe UI,system-ui,sans-serif;border-radius:12px;overflow:hidden;" +
    "box-shadow:0 8px 32px rgba(0,0,0,.2);z-index:99999;";

  const mag = Number(q.magnitude);
  const magStr = Number.isFinite(mag) ? mag.toFixed(1) : "—";
  const when =
    q.date && q.timeLocal
      ? `${q.date} ${q.timeLocal}`
      : typeof fmtTime === "function"
      ? fmtTime(q)
      : String(q.time || "—");
  const isTs = q.isTsunamiWarning || isTsunamiPotential(q.potential) || /tsunami/i.test(q.subject || "");
  const title = isTs
    ? q.subject || "INFO PERINGATAN TSUNAMI"
    : q.felt
    ? "INFO GEMPA DIRASAKAN"
    : mag >= 5
    ? "INFO GEMPA M≥5"
    : "INFO GEMPA";

  const maps = [];
  if (q.shakemap) maps.push({ label: "ShakeMap BMKG", url: q.shakemap });
  if (q.sshmap) maps.push({ label: "SSHmax (tinggi muka laut)", url: q.sshmap });
  if (q.wzmap) maps.push({ label: "Warning Zone", url: q.wzmap });
  if (q.ttmap) maps.push({ label: "Estimasi tiba tsunami", url: q.ttmap });

  const mapsHtml = maps
    .map(
      (m) =>
        `<div style="margin:10px 0"><div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px">${m.label}</div>` +
        `<img src="${m.url}" crossorigin="anonymous" style="width:100%;height:auto;display:block;border:1px solid #cbd5e1;border-radius:8px;background:#fff"/></div>`
    )
    .join("");

  wrap.innerHTML = `
    <div style="display:flex;background:linear-gradient(90deg,#b91c1c 28%,#eab308 28%);color:#0f172a;padding:16px;align-items:center;gap:14px">
      <div style="width:88px;height:88px;background:#7f1d1d;color:#fecaca;border:2px solid #fecaca;display:grid;place-items:center;font-size:32px;font-weight:900;flex-shrink:0">${magStr}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:900;color:#7f1d1d">${title}</div>
        <div style="font-size:12px;font-weight:700;margin-top:4px">WAKTU: ${when}</div>
        <div style="font-size:11px;color:#92400e;margin-top:2px">${q.timesent ? "Kirim: " + q.timesent : ""}</div>
      </div>
      <div style="width:48px;height:48px;border-radius:50%;background:#fff;border:2px solid #0c4a6e;display:grid;place-items:center;font-size:10px;font-weight:900;color:#0c4a6e">BMKG</div>
    </div>
    <div style="padding:14px 16px;font-size:13px;line-height:1.55;color:#1e293b">
      <div style="margin:6px 0"><b>Lokasi:</b> ${q.place || "—"}</div>
      <div style="margin:6px 0"><b>Koordinat:</b> ${typeof fmtCoord === "function" ? fmtCoord(q) : (q.lat + ", " + q.lon)}</div>
      <div style="margin:6px 0"><b>Kedalaman:</b> ${q.depth} km</div>
      <div style="margin:6px 0"><b>Sumber:</b> ${q.source || "BMKG / InaTEWS"}</div>
      <div style="margin:10px 0;padding:10px 12px;background:${isTs ? "#fef2f2" : "#f0fdf4"};border:1px solid ${isTs ? "#fca5a5" : "#86efac"};border-radius:8px;font-weight:600;color:${isTs ? "#991b1b" : "#166534"}">
        ${q.headline || q.potential || q.subject || "—"}
      </div>
      ${q.felt ? `<div style="margin:8px 0"><b>Dirasakan:</b> ${q.felt}</div>` : ""}
      ${q.instruction || q.instruction1 ? `<div style="margin:10px 0;padding:10px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px"><b>Arahan BMKG:</b><br>${[q.instruction, q.instruction1, q.instruction2, q.instruction3].filter(Boolean).join("<br>")}</div>` : ""}
      ${mapsHtml}
    </div>
    <div style="padding:10px 14px;background:#0f172a;color:#94a3b8;font-size:10px;text-align:center;font-weight:600">
      Independent monitoring by ilham · Sumber data resmi BMKG/InaTEWS
    </div>
  `;
  document.body.appendChild(wrap);
  return wrap;
}

/**
 * Simpan sebagai PNG tajam (kartu terang) + watermark
 */
async function saveModalAsImage(_cardEl, filename) {
  const q = window._modalQuake;
  if (!q) return;
  if (typeof html2canvas !== "function") {
    alert("Library html2canvas belum termuat. Coba refresh halaman.");
    return;
  }
  showLoading("Menyimpan gambar…");
  const exportEl = buildExportCard(q);
  try {
    const imgs = [...exportEl.querySelectorAll("img")];
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise((res) => {
            if (img.complete && img.naturalWidth > 0) return res();
            img.onload = res;
            img.onerror = res;
            setTimeout(res, 4000);
          })
      )
    );
    await new Promise((r) => setTimeout(r, 150));

    const canvas = await html2canvas(exportEl, {
      backgroundColor: "#f8fafc",
      scale: 2,
      useCORS: true,
      allowTaint: true,
      logging: false,
      scrollX: 0,
      scrollY: 0,
      width: exportEl.offsetWidth,
      height: exportEl.scrollHeight,
      windowWidth: exportEl.offsetWidth,
      windowHeight: exportEl.scrollHeight,
    });

    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = filename || "gempa.png";
    a.click();
  } catch (err) {
    console.warn("Save image gagal:", err);
    alert("Gagal menyimpan gambar. Coba lagi atau gunakan Bagikan.");
  } finally {
    exportEl.remove();
    hideLoading();
  }
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
      $("#pushStatus").textContent = "Push tersimpan · pengiriman belum diuji";
    }
  } catch (e) {
    console.error("SW register gagal", e);
  }
}

$("#btnPush").onclick = async () => {
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
      $("#pushStatus").textContent = "Service Worker gagal (butuh HTTPS). Deploy di Netlify lalu coba lagi.";
      return;
    }

    // 3) Subscribe push
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      } catch (subErr) {
        console.error(subErr);
        $("#pushStatus").textContent =
          "Gagal subscribe push — coba refresh, pastikan izin notifikasi ON, dan domain HTTPS.";
        return;
      }
    }

    // 4) Kirim ke server (Netlify Function + Blobs)
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
            ? "Server error — aktifkan Netlify Blobs + set VAPID_PRIVATE_KEY di Environment Variables Netlify"
            : `Gagal simpan subscription (HTTP ${res.status}). Cek Functions di Netlify.`;
      }
    } catch (netErr) {
      console.warn(netErr);
      $("#pushStatus").textContent =
        "Tidak terhubung ke /.netlify/functions/subscribe — pastikan Functions ter-deploy.";
    }

    // 5) Notifikasi lokal tetap diuji (meski server gagal)
    try {
      await reg.showNotification("Notifikasi aktif", {
        body: serverOk
          ? "Langganan push tersimpan. Pengiriman latar belakang tetap menunggu konfirmasi server."
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
      $("#pushStatus").textContent = "VAPID key tidak cocok — pastikan public key di app.js sama dengan private key di Netlify.";
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
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await load(false);
    scheduleRefresh();
  }, currentInterval());
}
scheduleRefresh();
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  if (quakes[0]) $("#rtAgo").textContent = timeAgo(quakes[0]);
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

  // Pause polling saat tab di background (hemat baterai HP)
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

/* Cuaca lokal terpisah dari informasi resmi gempa, memakai Open-Meteo tanpa API key. */
const WEATHER_CODES = {0:"Cerah",1:"Cerah berawan",2:"Berawan sebagian",3:"Mendung",45:"Kabut",48:"Kabut tebal",51:"Gerimis ringan",53:"Gerimis",55:"Gerimis lebat",61:"Hujan ringan",63:"Hujan",65:"Hujan lebat",71:"Salju ringan",73:"Salju",75:"Salju lebat",80:"Hujan lokal",81:"Hujan lokal",82:"Hujan lebat lokal",95:"Badai petir",96:"Badai petir dan hujan es",99:"Badai petir kuat"};
async function loadLocalWeather() {
  const card = $("#weatherCard");
  if (!card) return;
  card.classList.remove("hidden");
  $("#weatherPlace").textContent = "Meminta lokasi…";
  $("#weatherTemp").textContent = "—";
  $("#weatherDesc").textContent = "Memuat prakiraan saat ini";
  if (!navigator.geolocation) {
    $("#weatherPlace").textContent = "Lokasi tidak didukung";
    $("#weatherDesc").textContent = "Perangkat/browser tidak menyediakan lokasi.";
    return;
  }
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      const { latitude, longitude } = pos.coords;
      const url = "https://api.open-meteo.com/v1/forecast?latitude=" + latitude + "&longitude=" + longitude + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("weather_http_" + res.status);
      const data = await res.json(), w = data.current || {};
      $("#weatherPlace").textContent = latitude.toFixed(2) + ", " + longitude.toFixed(2);
      $("#weatherTemp").textContent = Number.isFinite(w.temperature_2m) ? Math.round(w.temperature_2m) + "°C" : "—";
      $("#weatherDesc").textContent = WEATHER_CODES[w.weather_code] || "Kondisi cuaca terkini";
      $("#weatherExtra").textContent = "Terasa " + (w.apparent_temperature ?? "—") + "°C · RH " + (w.relative_humidity_2m ?? "—") + "% · Angin " + (w.wind_speed_10m ?? "—") + " km/j · Hujan " + (w.precipitation ?? "—") + " mm. Bukan peringatan gempa.";
    } catch (err) {
      $("#weatherPlace").textContent = "Data cuaca tidak tersedia";
      $("#weatherDesc").textContent = "Periksa koneksi, lalu coba lagi.";
      console.warn("Weather request failed", err);
    }
  }, () => {
    $("#weatherPlace").textContent = "Izin lokasi belum diberikan";
    $("#weatherDesc").textContent = "Izinkan akses lokasi untuk cuaca lokal.";
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
}
function applyBatterySaver() {
  document.body.classList.toggle("battery-saver", batterySaver);
  const btn = $("#btnBattery");
  if (btn) {
    btn.textContent = batterySaver ? "Hemat baterai: aktif" : "Hemat baterai: mati";
    btn.setAttribute("aria-pressed", String(batterySaver));
  }
  clearTimeout(refreshTimer);
  if (!document.hidden) scheduleRefresh();
}
$("#btnWeather")?.addEventListener("click", loadLocalWeather);
$("#weatherClose")?.addEventListener("click", () => $("#weatherCard")?.classList.add("hidden"));
$("#btnBattery")?.addEventListener("click", () => {
  batterySaver = !batterySaver;
  localStorage.setItem("wrsBatterySaverV1", batterySaver ? "1" : "0");
  applyBatterySaver();
});
applyBatterySaver();




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
