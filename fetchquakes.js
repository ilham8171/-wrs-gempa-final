/**
 * Logika inti pengambilan & penggabungan data gempa.
 * Dipisah ke sini supaya dipakai bareng oleh:
 *  - earthquakes.js         (endpoint HTTP yang dipanggil frontend)
 *  - check-quakes-push.js   (scheduled function pengirim notifikasi latar belakang)
 */

const GCS = "https://bmkg-content-inatews.storage.googleapis.com";
const BMKG = [
  "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json",
];
/** GCS lebih stabil (data.bmkg.go.id sering 403 untuk .png/.jpg peta) */
const SHAKEMAP_BASE = "https://bmkg-content-inatews.storage.googleapis.com/";

const USGS =
  "https://earthquake.usgs.gov/fdsnws/event/1/query?" +
  new URLSearchParams({
    format: "geojson",
    starttime: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19),
    minlatitude: "-11",
    maxlatitude: "6.5",
    minlongitude: "94",
    maxlongitude: "141.5",
    minmagnitude: "2",
    orderby: "time",
    limit: "150",
  }).toString();

const UA = {
  "User-Agent": "GempaMonitor/5.1 (educational; Netlify)",
  Accept: "application/json",
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

function parseTimeStr(s) {
  if (!s) return "";
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) {
    const iso = t.replace(" ", "T");
    const d = new Date(iso.endsWith("Z") || /[+-]\d{2}/.test(iso) ? iso : iso + "Z");
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return t;
}

/** Bangun URL shakemap / peta penuh dari field mentah BMKG */
function shakemapUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^\/+/, "");
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    // Paksa host GCS jika path data.bmkg TEWS (hindari 403)
    s = s.replace(
      /^https?:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\//i,
      SHAKEMAP_BASE
    );
    return s;
  }
  return SHAKEMAP_BASE + s;
}

/** Buat kandidat nama file shakemap dari waktu (WIB) → YYYYMMDDHHmmss.mmi.jpg */
function shakemapFromTime(isoOrLocal) {
  if (!isoOrLocal) return null;
  const t = String(isoOrLocal).trim();
  // Sudah bentuk 14 digit
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 14) {
    return shakemapUrl(digits.slice(0, 14) + ".mmi.jpg");
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  // Konversi ke WIB (UTC+7)
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

function normQL(f) {
  if (!f?.properties || !f?.geometry) return null;
  const p = f.properties;
  const c = f.geometry.coordinates || [];
  const lon = num(c[0]);
  const lat = num(c[1]);
  const magnitude = num(p.mag ?? p.magnitude);
  if (!Number.isFinite(magnitude) || magnitude < 1.5) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const depth = parseDepth(p.depth);
  const time = parseTimeStr(p.time);
  const place = String(p.place || "Indonesia").trim();
  const id = String(p.id || `${time}|${magnitude}|${lat}|${lon}`);

  return {
    key: "ql|" + id,
    magnitude: Math.round(magnitude * 10) / 10,
    lat,
    lon,
    place,
    depth,
    time,
    potential: "—",
    felt: "",
    status: String(p.status || "M"),
    source: "InaTEWS",
    fase: p.fase || "",
    shakemap: null,
  };
}

function normDataGempa(j) {
  if (!j?.info) return null;
  const i = j.info;
  let lat = NaN,
    lon = NaN;
  const pt = i.point?.coordinates;
  if (pt) {
    const parts = String(pt).split(",").map((x) => num(x.trim()));
    if (parts.length >= 2) {
      lon = parts[0];
      lat = parts[1];
    }
  }
  if (!Number.isFinite(lat)) lat = parseLS(i.latitude);
  if (!Number.isFinite(lon)) lon = parseBT(i.longitude);

  const magnitude = num(i.magnitude);
  if (!Number.isFinite(magnitude)) return null;

  let time = "";
  if (i.date && i.time) {
    const dm = String(i.date).match(/(\d{2})-(\d{2})-(\d{2})/);
    const tm = String(i.time).match(/(\d{2}):(\d{2}):(\d{2})/);
    if (dm && tm) {
      const yy = 2000 + Number(dm[3]);
      const iso = `${yy}-${dm[2]}-${dm[1]}T${tm[1]}:${tm[2]}:${tm[3]}+07:00`;
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) time = d.toISOString();
    }
  }
  if (!time && j.sent) time = parseTimeStr(String(j.sent).replace("WIB", "").trim());

  return {
    key: "dg|" + (i.eventid || j.identifier || time),
    magnitude,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    place: String(i.area || "Indonesia").trim(),
    depth: parseDepth(i.depth),
    time,
    potential: String(i.potential || "—").trim(),
    felt: String(i.felt || "").trim(),
    status: "BMKG",
    source: "BMKG",
    headline: i.headline || "",
    instruction: i.instruction || "",
    timesent: i.timesent || "",
    official: true,
    shakemap: shakemapUrl(i.shakemap || i.Shakemap),
  };
}

function normPublic(raw) {
  if (!raw) return null;
  let lat = NaN,
    lon = NaN;
  const coord = raw.Coordinates ?? raw.coordinates;
  if (coord) {
    const p = String(coord).split(",").map((x) => num(x.trim()));
    if (p.length >= 2) {
      lat = p[0];
      lon = p[1];
    }
  }
  if (!Number.isFinite(lat)) lat = parseLS(raw.Lintang);
  if (!Number.isFinite(lon)) lon = parseBT(raw.Bujur);

  const magnitude = num(raw.Magnitude ?? raw.magnitude);
  if (!Number.isFinite(magnitude)) return null;

  return {
    key:
      "pub|" +
      (raw.DateTime ||
        `${raw.Tanggal}|${raw.Jam}|${magnitude}|${lat}|${lon}`),
    magnitude,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    place: String(raw.Wilayah || "Indonesia").trim(),
    depth: parseDepth(raw.Kedalaman),
    time: String(raw.DateTime || "").trim(),
    potential: String(raw.Potensi || "—").trim(),
    felt: String(raw.Dirasakan || "").trim(),
    status: "BMKG",
    source: "BMKG",
    official: true,
    shakemap:
      shakemapUrl(raw.Shakemap ?? raw.shakemap) ||
      // gempadirasakan.json sering tanpa field Shakemap — tebak dari DateTime
      shakemapFromTime(raw.DateTime || raw.dateTime),
  };
}

function normUsgs(f) {
  if (!f?.geometry?.coordinates || !f?.properties) return null;
  const [lon, lat, dep] = f.geometry.coordinates;
  const magnitude = num(f.properties.mag);
  if (!Number.isFinite(magnitude) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  return {
    key: "usgs|" + (f.id || f.properties.code || `${f.properties.time}`),
    magnitude,
    lat,
    lon,
    place: String(f.properties.place || "Indonesia").trim(),
    depth: dep != null ? String(Math.round(Number(dep) * 10) / 10) : "—",
    time: f.properties.time ? new Date(f.properties.time).toISOString() : "",
    potential: "—",
    felt: "",
    status: "USGS",
    source: "USGS",
    shakemap: null,
  };
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA, cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function fetchQL() {
  try {
    const j = await getJson(`${GCS}/gempaQL.json?t=${Date.now()}`);
    return (j.features || []).map(normQL).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchLastQL() {
  try {
    const j = await getJson(`${GCS}/lastQL.json?t=${Date.now()}`);
    return (j.features || []).map(normQL).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchDataGempa() {
  try {
    const j = await getJson(`${GCS}/datagempa.json?t=${Date.now()}`);
    const one = normDataGempa(j);
    return one ? [one] : [];
  } catch {
    return [];
  }
}

async function fetchPublic() {
  const out = [];
  await Promise.all(
    BMKG.map(async (url) => {
      try {
        const j = await getJson(url);
        const g = j?.Infogempa?.gempa;
        if (Array.isArray(g)) g.forEach((x) => {
          const n = normPublic(x);
          if (n) out.push(n);
        });
        else if (g) {
          const n = normPublic(g);
          if (n) out.push(n);
        }
      } catch {
        /* skip */
      }
    })
  );
  return out;
}

async function fetchUsgs() {
  try {
    const j = await getJson(USGS);
    return (j.features || []).map(normUsgs).filter(Boolean);
  } catch {
    return [];
  }
}

function near(a, b, km = 60) {
  if (
    !Number.isFinite(a.lat) ||
    !Number.isFinite(a.lon) ||
    !Number.isFinite(b.lat) ||
    !Number.isFinite(b.lon)
  )
    return false;
  const dlat = Math.abs(a.lat - b.lat);
  const dlon = Math.abs(a.lon - b.lon);
  return dlat < km / 111 && dlon < km / 111;
}

function mergeAll(ql, last, dg, pub, usgs) {
  const official = [...dg, ...pub].filter((q) => q.official);
  const catalog = [...last, ...ql];

  for (const o of official) {
    for (const c of catalog) {
      const ot = new Date(o.time).getTime();
      const ct = new Date(c.time).getTime();
      if (
        Number.isFinite(ot) &&
        Number.isFinite(ct) &&
        Math.abs(ot - ct) < 5 * 60 * 1000 &&
        Math.abs(o.magnitude - c.magnitude) < 0.5 &&
        near(o, c, 80)
      ) {
        c.potential = o.potential || c.potential;
        c.felt = o.felt || c.felt;
        c.place = o.place || c.place;
        c.official = true;
        c.source = "BMKG";
        if (o.headline) c.headline = o.headline;
        if (o.instruction) c.instruction = o.instruction;
        if (o.shakemap) c.shakemap = o.shakemap;
      }
    }
  }

  const merged = [...catalog];
  for (const o of official) {
    const dup = merged.some((c) => {
      const ot = new Date(o.time).getTime();
      const ct = new Date(c.time).getTime();
      return (
        Number.isFinite(ot) &&
        Number.isFinite(ct) &&
        Math.abs(ot - ct) < 5 * 60 * 1000 &&
        Math.abs(o.magnitude - c.magnitude) < 0.5 &&
        (near(o, c, 80) || !Number.isFinite(o.lat))
      );
    });
    if (!dup) merged.push(o);
  }

  for (const u of usgs) {
    const dup = merged.some((c) => {
      const ut = new Date(u.time).getTime();
      const ct = new Date(c.time).getTime();
      return (
        Number.isFinite(ut) &&
        Number.isFinite(ct) &&
        Math.abs(ut - ct) < 4 * 60 * 1000 &&
        Math.abs(u.magnitude - c.magnitude) < 0.5 &&
        near(u, c, 70)
      );
    });
    if (!dup) merged.push(u);
  }

  const byKey = new Map();
  const sig = new Set();
  const sorted = merged.sort((a, b) => {
    const ac = Number.isFinite(a.lat) ? 1 : 0;
    const bc = Number.isFinite(b.lat) ? 1 : 0;
    if (bc !== ac) return bc - ac;
    return 0;
  });
  for (const q of sorted) {
    if (byKey.has(q.key)) continue;
    const s = `${q.magnitude.toFixed(1)}|${(q.place || "").slice(0, 30)}|${String(q.time).slice(0, 16)}`;
    if (sig.has(s)) continue;
    byKey.set(q.key, q);
    sig.add(s);
  }

  return [...byKey.values()].sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
  );
}

/**
 * Daftar 30 peringatan dini tsunami terakhir (InaTEWS CAP XML)
 * Sumber sama dengan https://inatews.bmkg.go.id/web/tsunami
 */
function textBetween(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = String(xml).match(re);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}

function parseTsunamiCapXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  // Setiap blok <info>...</info> = satu PD / update
  const infos = xml.match(/<info>[\s\S]*?<\/info>/gi) || [];
  const list = [];
  for (const block of infos) {
    const subject = textBetween(block, "subject") || textBetween(block, "headline");
    const mag = num(textBetween(block, "magnitude"));
    const depthRaw = textBetween(block, "depth");
    const depth = parseDepth(depthRaw);
    const coords = textBetween(block, "coordinates");
    let lat = NaN, lon = NaN;
    if (coords) {
      const parts = coords.split(",").map((x) => num(x.trim()));
      if (parts.length >= 2) {
        // CAP InaTEWS: lon,lat
        lon = parts[0];
        lat = parts[1];
      }
    }
    if (!Number.isFinite(lat)) lat = parseLS(textBetween(block, "latitude"));
    if (!Number.isFinite(lon)) lon = parseBT(textBetween(block, "longitude"));
    const date = textBetween(block, "date");
    const time = textBetween(block, "time");
    const area = textBetween(block, "area");
    const eventid = textBetween(block, "eventid") || `${date}|${time}|${mag}`;
    const potential = textBetween(block, "potential") || subject;
    const shakemap = textBetween(block, "shakemap");
    const wzmap = textBetween(block, "wzmap");
    const ttmap = textBetween(block, "ttmap");
    const sshmap = textBetween(block, "sshmap");
    const instruction = textBetween(block, "instruction");
    const instruction1 = textBetween(block, "instruction1");
    const instruction2 = textBetween(block, "instruction2");
    const instruction3 = textBetween(block, "instruction3");
    const headline = textBetween(block, "headline");
    const description = textBetween(block, "description");
    const timesent = textBetween(block, "timesent");
    const pdMatch = subject.match(/PD[-\s]?([\d.]+)/i) || headline.match(/PD[-\s]?([\d.]+)/i);
    const pd = pdMatch ? pdMatch[1] : "";
    list.push({
      key: `tsun-${eventid}-${pd || list.length}`,
      eventid,
      magnitude: Number.isFinite(mag) ? mag : 0,
      depth,
      lat,
      lon,
      place: area || "Indonesia",
      time: parseTimeStr(`${date} ${time}`.replace(/-/g, " ")) || `${date} ${time}`,
      date,
      timeLocal: time,
      potential,
      subject: subject || `WARNING TSUNAMI PD-${pd || "?"}`,
      pd: pd || null,
      headline,
      description,
      instruction,
      instruction1,
      instruction2,
      instruction3,
      timesent,
      shakemap: shakemapUrl(shakemap) || shakemapFromTime(eventid),
      wzmap: shakemapUrl(wzmap),
      ttmap: shakemapUrl(ttmap),
      sshmap: shakemapUrl(sshmap),
      ended: /telah\s*berakhir|berakhir|all[\s-]?clear|dinyatakan\s*telah\s*berakhir/i.test(
        (headline || "") + " " + (description || "") + " " + (subject || "")
      ),
      source: "InaTEWS",
      isTsunamiWarning: true,
    });
  }
  return list;
}

async function fetchTsunamiHistory() {
  try {
    const r = await fetch("https://cdn.bmkg.go.id/last30tsunamievent.xml", {
      headers: {
        ...UA,
        Accept: "application/xml,text/xml,*/*",
        Referer: "https://inatews.bmkg.go.id/web/tsunami",
      },
      cache: "no-store",
    });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseTsunamiCapXml(xml);
  } catch (e) {
    console.warn("fetchTsunamiHistory", e);
    return [];
  }
}

async function fetchAll() {
  const [ql, last, dg, pub, usgs, tsunamiList] = await Promise.all([
    fetchQL(),
    fetchLastQL(),
    fetchDataGempa(),
    fetchPublic(),
    fetchUsgs(),
    fetchTsunamiHistory(),
  ]);

  const recent = mergeAll(ql, last, dg, pub, usgs).slice(0, 800);
  const official = [...dg, ...pub.filter((q) => q.official)].sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
  );

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    refreshSeconds: 8,
    latest: recent[0] || null,
    official: official[0] || recent.find((q) => q.official) || recent[0] || null,
    recent,
    count: recent.length,
    tsunamiHistory: tsunamiList,
    sources: {
      inaQL: ql.length,
      lastQL: last.length,
      dataGempa: dg.length,
      public: pub.length,
      usgs: usgs.length,
      tsunami: tsunamiList.length,
    },
  };
}

/**
 * Cache in-memory per container (bertahan selama Netlify function tetap "warm",
 * biasanya beberapa menit). Ini yang mencegah tiap client polling 8 detik
 * memicu fetch penuh ke 3+ sumber upstream setiap kali — banyak client dalam
 * jendela waktu yang sama akan berbagi 1 hasil fetch yang sama.
 */
let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 6000;

async function getQuakesCached() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }
  const data = await fetchAll();
  cache = { data, ts: now };
  return data;
}

module.exports = { fetchAll, getQuakesCached };
