const SOURCES = [
  { url: "https://www.bmkg.go.id/berita", category: "Berita BMKG", pattern: /\/berita\//i },
  { url: "https://www.bmkg.go.id/siaran-pers", category: "Siaran Pers", pattern: /\/siaran-pers\//i }
];
const clean = (value) => String(value || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim();
export async function onRequestGet() {
  const gathered = [];
  const results = await Promise.allSettled(SOURCES.map(async source => {
    const response = await fetch(source.url, {
      headers: { "user-agent": "WRS-GEMPA/1.0 (+official BMKG news reader)", "accept": "text/html" },
      cf: { cacheTtl: 180, cacheEverything: true }
    });
    if (!response.ok) throw new Error("BMKG source HTTP " + response.status);
    const html = await response.text();
    const anchors = html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) || [];
    const items = [];
    for (const anchor of anchors) {
      const hrefMatch = anchor.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      let url;
      try { url = new URL(hrefMatch[1], "https://www.bmkg.go.id"); } catch { continue; }
      if (url.hostname !== "www.bmkg.go.id" && url.hostname !== "bmkg.go.id") continue;
      if (!source.pattern.test(url.pathname)) continue;
      const title = clean(anchor);
      if (title.length < 18 || title.length > 220) continue;
      items.push({ title, url: url.href, category: source.category, date: "" });
    }
    return items;
  }));
  for (const result of results) if (result.status === "fulfilled") gathered.push(...result.value);
  const unique = [...new Map(gathered.map(item => [item.url, item])).values()].slice(0, 80);
  return new Response(JSON.stringify({
    items: unique,
    fetchedAt: new Date().toISOString(),
    sourceStatus: results.map((result, index) => ({
      source: SOURCES[index].category,
      ok: result.status === "fulfilled",
      error: result.status === "rejected" ? String(result.reason?.message || "Sumber tidak tersedia") : ""
    }))
  }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=180",
      "access-control-allow-origin": "*"
    }
  });
}
