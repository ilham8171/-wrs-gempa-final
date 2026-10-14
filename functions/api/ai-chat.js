const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const SYSTEM_PROMPT = [
  "Kamu adalah WRS GEMPA AI, asisten informasi gempa bumi, tsunami, seismologi dasar, dan kesiapsiagaan bencana yang berbahasa Indonesia.",
  "",
  "TUJUAN DAN CARA MENJAWAB",
  "Berikan jawaban yang jelas, teliti, bernalar kuat, relevan, dan mudah dipahami masyarakat umum. Jawab inti pertanyaan terlebih dahulu, lalu jelaskan bukti katalog, arti datanya, faktor yang perlu diperhatikan, dan batas kepastian jika relevan.",
  "Lakukan penalaran internal secara mendalam: pahami maksud pertanyaan, periksa data yang tersedia, bandingkan waktu dan sumber, cari ketidaksesuaian, pisahkan fakta dari penjelasan umum, lalu simpulkan secara proporsional. Jangan menampilkan rantai pikiran internal atau mengaku melakukan pemeriksaan yang tidak benar-benar dilakukan. Berikan kesimpulan dan ringkasan alasan yang dapat dipahami pengguna.",
  "Jawab singkat untuk pertanyaan sederhana. Jika pengguna meminta analisis mendalam, perbandingan, atau penjelasan lengkap, uraikan lebih jauh secara terstruktur tanpa mengulang hal yang sama.",
  "",
  "FORMAT WAJIB",
  "Gunakan teks biasa yang rapi. Jangan gunakan Markdown, tanda bintang untuk penekanan, simbol pagar untuk judul, backtick, tabel Markdown, atau format tebal/miring. Jangan pernah mengeluarkan karakter bintang. Jangan menulis data dalam tabel.",
  "Gunakan judul sederhana seperti Ringkasan, Data yang tersedia, Penjelasan, dan Batasan jika memang membantu. Untuk urutan tindakan atau perbandingan, gunakan penomoran biasa seperti 1. dan 2. Pisahkan bagian dengan baris baru dan paragraf yang pendek.",
  "Hindari dinding teks, simbol format mentah, baris tabel dengan tanda |, pengulangan, dan kalimat yang terlalu panjang. Gunakan angka dengan satuan yang jelas.",
  "",
  "SUMBER DAN KATALOG",
  "Gunakan katalog yang disertakan dalam permintaan sebagai satu-satunya sumber fakta terkini tentang kejadian di WRS GEMPA. Jangan mengarang peristiwa, waktu, lokasi, magnitudo, kedalaman, koordinat, dampak, status sumber, atau tautan.",
  "Untuk informasi resmi Indonesia, utamakan catatan BMKG atau InaTEWS yang secara jelas ditandai resmi. Data USGS berguna sebagai sumber pembanding atau pelengkap, tetapi jangan menyebutnya sebagai peringatan resmi Indonesia.",
  "Perhatikan waktu pembaruan katalog, status sumber, tanda cache lama, dan catatan kegagalan sumber. Jika data terlambat, memakai cache, kosong, atau saling bertentangan, jelaskan batasannya. Jangan menyebut katalog lengkap bila metadata menunjukkan data parsial atau darurat.",
  "Jika menjelaskan kejadian tertentu, sebutkan data yang memang tersedia: waktu kejadian, lokasi, magnitudo, kedalaman, sumber, koordinat, dan ketersediaan ShakeMap. Jangan mengarang kolom yang kosong. Jika pengguna menyebut waktu lokal, beri label zona waktu dengan benar dan jangan menebak zona waktu dari data yang ambigu.",
  "",
  "TSUNAMI DAN SHAKE MAP",
  "Riwayat atau arsip buletin tsunami adalah catatan historis, bukan bukti bahwa peringatan masih aktif sekarang. Periksa apakah konteks benar-benar memberikan status resmi terkini, waktu berlaku, waktu berakhir, dan instruksi yang sesuai. Jika status aktif tidak tersedia, katakan bahwa katalog yang diterima belum memastikan status peringatan saat ini dan arahkan pengguna untuk memeriksa BMKG/InaTEWS.",
  "Penanda tsunami dari USGS bukan peringatan tsunami resmi. Jangan menyimpulkan ada atau tidak ada tsunami hanya dari magnitudo, kedalaman, lokasi, flag USGS, atau buletin lama.",
  "Katakan ShakeMap tersedia hanya jika katalog memuat tautan atau aset ShakeMap yang nyata. Jika tidak tersedia dalam katalog, katakan demikian. Jangan membuat nilai MMI atau peta intensitas sendiri.",
  "",
  "PENJELASAN ILMIAH YANG AMAN",
  "Jangan pernah memprediksi waktu, lokasi, atau magnitudo gempa yang akan datang. Jangan memastikan atau meramal gempa susulan. Kamu boleh menjelaskan bahwa gempa susulan dapat terjadi setelah gempa utama, tetapi tidak dapat memastikan apakah atau kapan hal itu akan terjadi pada kejadian tertentu.",
  "Magnitudo menggambarkan ukuran sumber gempa; intensitas menggambarkan guncangan dan dampak di suatu tempat. Dampak dipengaruhi antara lain jarak, kedalaman, kondisi tanah, bangunan, durasi guncangan, dan mekanisme sumber. Jangan menyimpulkan kerusakan pasti dari magnitudo saja.",
  "Jangan mengarang MMI, jumlah korban, kerusakan, laporan masyarakat, evakuasi, atau kondisi lapangan. Bedakan fakta katalog dari pengetahuan umum. Beri tahu jika suatu hal tidak bisa ditentukan dari data yang diterima.",
  "Saat menjelaskan potensi tsunami secara umum, terangkan faktor ilmiah seperti lokasi di laut, kedalaman, mekanisme patahan, dan perpindahan dasar laut tanpa mengubahnya menjadi klaim peringatan untuk kejadian tertentu.",
  "",
  "KESELAMATAN DAN BATASAN",
  "AI bukan kanal peringatan resmi dan tidak menggantikan arahan petugas. Untuk situasi nyata atau darurat, anjurkan mengikuti BMKG, InaTEWS, BNPB/BPBD, dan petugas setempat. Jangan menenangkan secara berlebihan dan jangan menakut-nakuti.",
  "Jangan mengaku sedang memantau gempa secara langsung, telah menghubungi pihak tertentu, atau telah melakukan tindakan. Jelaskan dengan jujur data apa yang tersedia pada permintaan ini.",
  "Jika pertanyaan bersifat edukasi dan tidak memerlukan data terkini, tetap bantu dengan pengetahuan umum yang mapan sambil membedakannya dengan data katalog."
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function normalizeAnswer(value, max = 6000) {
  let text = String(value ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
  text = text.split(String.fromCharCode(96)).join("");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/\*\*(.*?)\*\*/gs, "$1").replace(/__(.*?)__/gs, "$1");
  text = text.replace(/^\s*[*+]\s+/gm, "• ");
  text = text.replace(/^\s*[-+]\s+/gm, "• ");
  text = text.replace(/\*/g, "");

  const lines = text.split("\n").map(line => {
    if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) return "";
    if (/^\s*\|.*\|\s*$/.test(line)) {
      return line.split("|").slice(1, -1).map(cell => cell.trim()).filter(Boolean).join(" — ");
    }
    return line.replace(/\s+\|\s+/g, "; ");
  });

  text = lines
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, max).trim();
}

function summarizeEvent(item) {
  if (!item || typeof item !== "object") return null;
  const p = item.properties || item;
  const coords = item.geometry?.coordinates;
  const time = p.time || p.datetime || p.originTime || p.date || p.timesent || p.effective;
  return {
    time: cleanText(time, 60),
    sentAt: cleanText(p.timesent || "", 60),
    magnitude: p.magnitude ?? p.mag ?? p.magnitudo ?? null,
    depthKm: p.depthKm ?? p.depth ?? p.kedalaman ?? (Array.isArray(coords) ? coords[2] : null),
    place: cleanText(p.place || p.location || p.wilayah || p.area || p.region, 180),
    source: cleanText(p.source || p.sumber, 40),
    latitude: p.latitude ?? p.lat ?? p.lintang ?? (Array.isArray(coords) ? coords[1] : null),
    longitude: p.longitude ?? p.lon ?? p.bujur ?? (Array.isArray(coords) ? coords[0] : null),
    official: p.official === true,
    shakemapAvailable: Boolean(p.shakemap || p.shakeMap || p.shakemapUrl),
    shakemapSource: cleanText(p.shakemapSource || "", 60),
    usgsTsunamiFlag: p.usgsTsunamiFlag === true || Number(p.tsunami) === 1,
    tsunamiStatus: cleanText(p.tsunamiStatus || p.tsunami_status || p.headline || p.subject || p.potential || "", 180),
    bulletinLevel: cleanText(p.pd || "", 20),
    bulletinStatus: cleanText(p.capStatus || p.capMsgType || "", 50),
    instruction: cleanText(p.instruction || p.instruction1 || "", 240),
    ended: p.ended === true,
    expires: cleanText(p.expires || "", 60)
  };
}

function summarizeCatalog(payload) {
  if (!payload || typeof payload !== "object") {
    return { available: false, note: "Katalog gempa tidak tersedia." };
  }

  const candidates = [
    payload.recent,
    payload.earthquakes,
    payload.events,
    payload.features,
    payload.realtimeEvents,
    payload.data?.recent,
    payload.data?.earthquakes
  ];
  const list = candidates.find(Array.isArray) || [];
  const events = list.slice(0, 25).map(summarizeEvent).filter(Boolean);
  const tsunamiHistory = Array.isArray(payload.tsunamiHistory)
    ? payload.tsunamiHistory.slice(0, 10).map(item => ({
        ...summarizeEvent(item),
        subject: cleanText(item?.subject || "", 160),
        headline: cleanText(item?.headline || "", 240),
        description: cleanText(item?.description || "", 400),
        instruction: cleanText(item?.instruction || item?.instruction1 || "", 300),
        ended: item?.ended === true,
        expires: cleanText(item?.expires || "", 60)
      })).filter(Boolean)
    : null;

  const rawSources = payload.sources || payload.sourceStatus || {};
  return {
    available: events.length > 0 || Boolean(payload.latest || payload.realtime || payload.official),
    fetchedAt: cleanText(payload.fetchedAt || payload.updatedAt || payload.timestamp, 60),
    latest: summarizeEvent(payload.latest),
    officialLatest: summarizeEvent(payload.official),
    realtime: summarizeEvent(payload.realtime),
    eventCountReported: Number.isFinite(Number(payload.count)) ? Number(payload.count) : null,
    eventCountIncluded: events.length,
    events,
    tsunamiHistoryAvailable: tsunamiHistory !== null,
    tsunamiHistoryIsArchiveOnly: true,
    tsunamiHistoryCountIncluded: tsunamiHistory?.length ?? 0,
    tsunamiHistory,
    currentOfficialTsunamiStatus: cleanText(
      payload.activeTsunamiWarning?.status ||
      payload.tsunamiWarningStatus ||
      payload.activeWarning?.status ||
      "",
      120
    ) || null,
    sourceStatus: {
      staleCache: Boolean(rawSources.staleCache || rawSources.durableStaleCache),
      emergencyFallback: Boolean(rawSources.emergencyFallback),
      staleAgeSeconds: rawSources.staleAgeSeconds ?? null,
      wrs: rawSources.wrs ? {
        ok: rawSources.wrs.ok === true,
        eventCount: rawSources.wrs.eventCount ?? null,
        error: cleanText(rawSources.wrs.error || "", 180)
      } : null,
      wrsHistory: rawSources.wrsHistory ? {
        ok: rawSources.wrsHistory.ok === true,
        eventCount: rawSources.wrsHistory.eventCount ?? null,
        cached: rawSources.wrsHistory.cached === true,
        cacheAgeSeconds: rawSources.wrsHistory.cacheAgeSeconds ?? null,
        error: cleanText(rawSources.wrsHistory.error || "", 180)
      } : null,
      publicEvents: rawSources.publicEvents ?? null,
      usgsEvents: rawSources.usgsGlobal ?? rawSources.usgs ?? null,
      tsunamiArchiveCount: rawSources.tsunami ?? tsunamiHistory?.length ?? null,
      errors: Array.isArray(rawSources.errors)
        ? rawSources.errors.slice(0, 8).map(error => cleanText(error, 180))
        : []
    }
  };
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "AI belum dikonfigurasi. Admin perlu menambahkan Secret GEMINI_API_KEY di Cloudflare Pages Production." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Format permintaan tidak valid." }, 400); }
  const rawMessage = typeof body?.message === "string" ? body.message : "";
  if (rawMessage.length > 1200) return json({ error: "Pertanyaan terlalu panjang (maksimal 1.200 karakter)." }, 413);
  const question = cleanText(rawMessage, 1200);
  if (!question || question.length < 2) return json({ error: "Tulis pertanyaan terlebih dahulu." }, 400);
  let catalog = { available: false, note: "Katalog live tidak berhasil dibaca." };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(new URL("/api/earthquakes", request.url), { headers: { accept: "application/json" }, signal: controller.signal });
      if (response.ok) catalog = summarizeCatalog(await response.json());
      else catalog.note = "Endpoint katalog merespons HTTP " + response.status + ".";
    } finally { clearTimeout(timer); }
  } catch (error) { catalog.note = "Katalog live tidak berhasil dibaca: " + cleanText(error?.message || "koneksi atau waktu tunggu habis", 120); }
  const model = cleanText(env.GEMINI_MODEL || "gemini-3.5-flash-lite", 100);
  const userPrompt = "WAKTU PERMINTAAN UTC: " + new Date().toISOString() +
    "\nKONTEKS KATALOG WRS GEMPA. Data dapat tidak lengkap; arsip tsunami bukan status aktif:\n" +
    JSON.stringify(catalog).slice(0, 14000) + "\n\nPERTANYAAN PENGGUNA:\n" + question;
  let upstream;
  try {
    upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1600 }
      }),
      signal: AbortSignal.timeout(25000)
    });
  } catch (error) {
    console.error("[WRS AI] Gemini request failed:", cleanText(error?.message || "network or timeout", 180));
    return json({ error: "Layanan Gemini sedang tidak dapat dijangkau atau membutuhkan waktu terlalu lama. Coba lagi sebentar." }, 502);
  }
  let result;
  try { result = await upstream.json(); } catch { return json({ error: "Respons Gemini tidak dapat dibaca." }, 502); }
  if (!upstream.ok) {
    console.error("[WRS AI] Gemini request failed with status", upstream.status, cleanText(result?.error?.message || "", 220));
    if (upstream.status === 429) return json({ error: "Batas penggunaan Gemini tercapai untuk sementara. Coba lagi nanti atau periksa kuota proyek di Google AI Studio." }, 429);
    if (upstream.status === 401 || upstream.status === 403) return json({ error: "Google Gemini menolak API key atau aksesnya. Periksa Secret GEMINI_API_KEY di Cloudflare Pages Production dan pastikan deployment terbaru aktif." }, 502);
    if (upstream.status === 400 || upstream.status === 404) return json({ error: "Permintaan Gemini atau nama model tidak diterima. Periksa GEMINI_MODEL; model default adalah gemini-3.5-flash-lite." }, 502);
    return json({ error: "Gemini belum berhasil memproses pertanyaan. Coba lagi nanti." }, 502);
  }
  const answer = normalizeAnswer((result.candidates?.[0]?.content?.parts || []).map(part => typeof part.text === "string" ? part.text : "").join("\n"), 6000);
  if (!answer) {
    console.error("[WRS AI] Gemini returned no usable text.");
    return json({ error: "Gemini tidak memberikan jawaban teks. Silakan coba lagi." }, 502);
  }
  return json({ answer, model, provider: "Gemini", liveCatalogAvailable: Boolean(catalog.available), catalogFetchedAt: catalog.fetchedAt || null });
}
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...JSON_HEADERS,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}
