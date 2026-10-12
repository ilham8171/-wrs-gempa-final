const BMKG_ALERTS = "https://www.bmkg.go.id/alerts/nowcast/id";
const BMKG_NEWS_PAGES = [
  ["https://www.bmkg.go.id/berita", "Berita BMKG"],
  ["https://www.bmkg.go.id/siaran-pers", "Siaran Pers BMKG"]
];
const strip = value => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
  .replace(/\s+/g, " ").trim();
function tag(xml, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  return (xml.match(re) || [, ""])[1];
}
function parseRss(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const title = strip(tag(item, "title"));
    const url = strip(tag(item, "link"));
    const description = strip(tag(item, "description"));
    const updated = strip(tag(item, "pubDate"));
    if (!title || !/^https:\/\/(www\.)?bmkg\.go\.id\//i.test(url)) return null;
    return { title, description, url, updated };
  }).filter(Boolean).slice(0, 100);
}
function articleSummary(html) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const meta = metas.find(tag => /(?:name|property)=["'](?:description|og:description)["']/i.test(tag));
  let summary = meta ? ((meta.match(/content=["']([\s\S]*?)["']/i) || [, ""])[1]) : "";
  if (!summary) {
    const paragraphs = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    summary = paragraphs.map(strip).find(p => p.length >= 60 && !/cookie|copyright|ikuti kami|baca juga/i.test(p)) || "";
  }
  summary = strip(summary).replace(/^(?:siaran pers|berita bmkg)\s*[:—-]\s*/i, "");
  if (summary.length > 320) summary = summary.slice(0, 317).replace(/\s+\S*$/, "") + "…";
  return summary;
}
async function fetchNewsPage([pageUrl, category]) {
  const response = await fetch(pageUrl, { headers: { accept: "text/html" }, cf: { cacheTtl: 180, cacheEverything: true } });
  if (!response.ok) throw new Error("BMKG news HTTP " + response.status);
  const html = await response.text();
  const anchors = html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  return anchors.map(anchor => {
    const match = anchor.match(/href=["']([^"']+)["']/i);
    if (!match) return null;
    let url;
    try { url = new URL(match[1], "https://www.bmkg.go.id"); } catch { return null; }
    const title = strip(anchor);
    const path = url.pathname.replace(/\/$/, "");
    if (!/^(?:www\.)?bmkg\.go\.id$/i.test(url.hostname) ||
        !/\/(?:berita|siaran-pers)\//i.test(url.pathname) ||
        title.length < 22 || title.length > 200 ||
        path === new URL(pageUrl).pathname.replace(/\/$/, "")) return null;
    return { title, url: url.href, category: /siaran-pers/i.test(url.pathname) ? "Siaran Pers BMKG" : category };
  }).filter(Boolean);
}
export async function onRequestGet() {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60, s-maxage=120", "access-control-allow-origin": "*" };
  const outcomes = await Promise.allSettled([
    fetch(BMKG_ALERTS, { headers: { accept: "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: 60, cacheEverything: true } })
      .then(async response => { if (!response.ok) throw new Error("BMKG nowcast HTTP " + response.status); return parseRss(await response.text()); }),
    Promise.all(BMKG_NEWS_PAGES.map(fetchNewsPage)).then(groups => groups.flat())
  ]);
  const alerts = outcomes[0].status === "fulfilled" ? outcomes[0].value.map(item => ({
    title: item.title, description: item.description, url: item.url, updated: item.updated,
    area: (item.description.match(/(?:wilayah|daerah|kecamatan|kabupaten)[^.;]{0,180}/i) || [])[0] || "",
    severity: /sangat lebat|ekstrem|ekstrim|siaga/i.test(item.title + " " + item.description) ? "severe" : "active"
  })) : [];
  const uniqueNews = outcomes[1].status === "fulfilled"
    ? [...new Map(outcomes[1].value.map(item => [item.url, item])).values()].slice(0, 8)
    : [];
  // Summaries come from the official BMKG page description/intro, not invented.
  const news = await Promise.all(uniqueNews.slice(0, 6).map(async item => {
    try {
      const response = await fetch(item.url, { headers: { accept: "text/html" }, cf: { cacheTtl: 300, cacheEverything: true } });
      if (!response.ok) return { ...item, summary: "" };
      return { ...item, summary: articleSummary(await response.text()) };
    } catch { return { ...item, summary: "" }; }
  }));
  return new Response(JSON.stringify({
    alerts, news, fetchedAt: new Date().toISOString(), source: "BMKG",
    sourceStatus: { alerts: outcomes[0].status === "fulfilled", news: outcomes[1].status === "fulfilled" }
  }), { headers });
}
