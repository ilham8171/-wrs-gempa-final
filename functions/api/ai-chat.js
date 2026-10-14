const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const SYSTEM_PROMPT = `Kamu adalah WRS GEMPA AI, asisten informasi gempa dan kebencanaan berbahasa Indonesia.
Aturan wajib:
- Gunakan hanya data katalog yang diberikan sebagai fakta terkini. Sebutkan bila data tidak tersedia, mungkin tertunda, atau tidak cukup.
- Jangan pernah memprediksi waktu/lokasi/magnitudo gempa, memastikan gempa susulan, atau mengarang MMI/ShakeMap.
- Jangan menyatakan tsunami aktif kecuali konteks data secara eksplisit memuat status peringatan resmi yang masih berlaku. Jika status tidak jelas, katakan perlu memeriksa kanal resmi BMKG/InaTEWS.
- AI bukan pengganti peringatan resmi. Untuk keadaan darurat, ikuti BMKG, InaTEWS, BNPB/BPBD dan petugas setempat.
- Jelaskan perbedaan magnitudo, kedalaman, intensitas, dan peringatan dengan sederhana. Hindari menakut-nakuti.
- Jawab ringkas, jelas, dan jangan mengklaim telah melakukan tindakan atau memantau sistem secara langsung.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function summarizeCatalog(payload) {
  if (!payload || typeof payload !== "object") return { available: false, note: "Katalog gempa tidak tersedia." };
  const candidates = [payload.recent, payload.earthquakes, payload.events, payload.features, payload.data?.recent, payload.data?.earthquakes];
  const list = candidates.find(Array.isArray) || [];
  const events = list.slice(0, 35).map(item => {
    const p = item?.properties || item || {};
    const coords = item?.geometry?.coordinates;
    return {
      time: cleanText(p.time || p.datetime || p.originTime || p.date, 50),
      magnitude: p.magnitude ?? p.mag ?? p.magnitudo ?? null,
      depthKm: p.depthKm ?? p.depth ?? p.kedalaman ?? (Array.isArray(coords) ? coords[2] : null),
      place: cleanText(p.place || p.location || p.wilayah || p.area || p.region, 180),
      source: cleanText(p.source || p.sumber, 40),
      latitude: p.latitude ?? p.lat ?? (Array.isArray(coords) ? coords[1] : null),
      longitude: p.longitude ?? p.lon ?? (Array.isArray(coords) ? coords[0] : null),
      shakemapAvailable: Boolean(p.shakemap || p.shakeMap || p.shakemapUrl),
      tsunamiStatus: cleanText(p.tsunamiStatus || p.tsunami_status || "", 100)
    };
  });
  return {
    available: events.length > 0,
    fetchedAt: cleanText(payload.fetchedAt || payload.updatedAt || payload.timestamp, 50),
    sourceStatus: payload.sources || payload.sourceStatus || null,
    eventCountIncluded: events.length,
    events
  };
}

export async function onRequestPost({ request, env }) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "AI belum dikonfigurasi. Admin perlu menambahkan secret GROQ_API_KEY di Cloudflare Pages." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Format permintaan tidak valid." }, 400); }
  const rawMessage = typeof body?.message === "string" ? body.message : "";
  if (rawMessage.length > 1200) return json({ error: "Pertanyaan terlalu panjang (maksimal 1.200 karakter)." }, 413);
  const question = cleanText(rawMessage, 1200);
  if (!question || question.length < 2) return json({ error: "Tulis pertanyaan terlebih dahulu." }, 400);

  let catalog = { available: false, note: "Katalog live tidak berhasil dibaca." };
  try {
    const catalogUrl = new URL("/api/earthquakes", request.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(catalogUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (response.ok) catalog = summarizeCatalog(await response.json());
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    // General educational questions can still be answered, but live data is marked unavailable.
  }

  const model = cleanText(env.GROQ_MODEL || "openai/gpt-oss-20b", 100);
  let upstream;
  try {
    upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.GROQ_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: "KONTEKS KATALOG WRS GEMPA (data dapat tidak lengkap):\n" +
              JSON.stringify(catalog).slice(0, 14000) +
              "\n\nPERTANYAAN PENGGUNA:\n" + question
          }
        ],
        max_tokens: 650,
        temperature: 0.2,
        stream: false
      }),
      signal: AbortSignal.timeout(18000)
    });
  } catch (_) {
    return json({ error: "Layanan AI sedang tidak dapat dijangkau. Coba lagi sebentar." }, 502);
  }

  if (!upstream.ok) {
    const status = upstream.status;
    console.error("[WRS AI] Groq request failed with status", status);
    if (status === 401 || status === 403) return json({ error: "Konfigurasi API Groq ditolak. Admin perlu memeriksa secret dan akses model." }, 502);
    if (status === 429) return json({ error: "Kuota atau batas permintaan Groq tercapai. Coba lagi nanti." }, 429);
    if (status === 400 || status === 404) return json({ error: "Model AI tidak tersedia atau permintaan ditolak. Admin perlu memeriksa GROQ_MODEL." }, 502);
    return json({ error: "AI belum berhasil memproses pertanyaan. Coba lagi nanti." }, 502);
  }

  let result;
  try { result = await upstream.json(); } catch { return json({ error: "Respons AI tidak dapat dibaca." }, 502); }
  const answer = cleanText(result.choices?.[0]?.message?.content || "", 6000);
  if (!answer) return json({ error: "AI tidak memberikan jawaban. Silakan coba lagi." }, 502);
  return json({ answer, model, provider: "Groq", liveCatalogAvailable: Boolean(catalog.available) });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { ...JSON_HEADERS, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
}
