const BMKG_ALERTS = "https://www.bmkg.go.id/alerts/nowcast/id";
const strip = value => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ").trim();
function tag(xml, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  return (xml.match(re) || [,""])[1];
}
function parseRss(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const title = strip(tag(item,"title"));
    const url = strip(tag(item,"link"));
    const description = strip(tag(item,"description"));
    const updated = strip(tag(item,"pubDate"));
    if (!title || !/^https:\/\/(www\.)?bmkg\.go\.id\//i.test(url)) return null;
    return { title, description, url, updated };
  }).filter(Boolean).slice(0,100);
}
export async function onRequestGet() {
  const headers = { "content-type":"application/json; charset=utf-8", "cache-control":"public, max-age=60, s-maxage=120", "access-control-allow-origin":"*" };
  const outcomes = await Promise.allSettled([
    fetch(BMKG_ALERTS,{headers:{accept:"application/rss+xml, application/xml, text/xml"},cf:{cacheTtl:60,cacheEverything:true}}).then(async r=>{if(!r.ok)throw new Error("BMKG nowcast HTTP "+r.status);return parseRss(await r.text());}),
    fetch("https://www.bmkg.go.id/berita",{headers:{accept:"text/html"},cf:{cacheTtl:180,cacheEverything:true}}).then(async r=>{if(!r.ok)throw new Error("BMKG news HTTP "+r.status);const html=await r.text();const anchors=html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi)||[];return anchors.map(a=>{const m=a.match(/href=["']([^"']+)["']/i);if(!m)return null;let u;try{u=new URL(m[1],"https://www.bmkg.go.id")}catch{return null}const title=strip(a);if(!/^www\.bmkg\.go\.id$|^bmkg\.go\.id$/i.test(u.hostname)||!(/\/(berita|siaran-pers)\//i.test(u.pathname))||title.length<22||title.length>200)return null;return {title,url:u.href,category:/siaran-pers/i.test(u.pathname)?"Siaran Pers BMKG":"Berita BMKG",date:"Rilis resmi BMKG"};}).filter(Boolean).slice(0,20);})
  ]);
  const alerts = outcomes[0].status==="fulfilled" ? outcomes[0].value.map(item=>({
    title:item.title,description:item.description,url:item.url,updated:item.updated,
    area:(item.description.match(/(?:wilayah|daerah|kecamatan|kabupaten)[^.;]{0,180}/i)||[])[0]||"",
    severity:/sangat lebat|ekstrem|ekstrim|siaga/i.test(item.title+" "+item.description)?"severe":"active"
  })) : [];
  const news = outcomes[1].status==="fulfilled" ? [...new Map(outcomes[1].value.map(item=>[item.url,item])).values()].slice(0,8) : [];
  return new Response(JSON.stringify({alerts,news,fetchedAt:new Date().toISOString(),source:"BMKG",sourceStatus:{alerts:outcomes[0].status==="fulfilled",news:outcomes[1].status==="fulfilled"}}),{headers});
}
