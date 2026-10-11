const { schedule } = require("@netlify/functions");
const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");
const { fetchAll } = require("./_shared/fetchQuakes");

async function handler() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.error("Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in Netlify environment");
    return { statusCode: 500, body: "push not configured" };
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", publicKey, privateKey);
  try {
    const subsStore = getStore("push-subscriptions");
    const deliveryStore = getStore("push-delivery-state");
    const data = await fetchAll();
    const latest = data && data.latest;
    if (!latest || !latest.key) return { statusCode: 200, body: "no data" };
    const { blobs } = await subsStore.list();
    if (!blobs.length) return { statusCode: 200, body: "no subscribers" };
    const payload = JSON.stringify({
      title: `Gempa M${Number(latest.magnitude || 0).toFixed(1)}`,
      body: `${latest.place || "Lokasi tidak diketahui"} · kedalaman ${latest.depth ?? "—"} km`,
      magnitude: latest.magnitude, place: latest.place, time: latest.time,
      key: latest.key, tsunami: Boolean(latest.tsunami),
      url: `/?quake=${encodeURIComponent(latest.key)}`
    });
    let attempts = 0;
    let skipped = 0;
    await Promise.all(blobs.map(async ({ key }) => {
      const sub = await subsStore.get(key, { type: "json" });
      if (!sub) return;
      const deliveredKey = await deliveryStore.get(key);
      if (deliveredKey === latest.key) {
        skipped++;
        return;
      }
      try {
        await webpush.sendNotification(sub, payload, { TTL: 300 });
        await deliveryStore.set(key, latest.key);
        attempts++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await subsStore.delete(key);
          await deliveryStore.delete(key);
        } else {
          console.error("Web Push delivery failed", err.statusCode || err.message);
        }
      }
    }));
    return {
      statusCode: attempts > 0 || skipped > 0 ? 200 : 502,
      body: `delivered: ${attempts}; already delivered: ${skipped}; failed subscriptions are retried on next check`
    };
  } catch (err) {
    console.error("check-quakes-push failed", err);
    return { statusCode: 500, body: "push check failed" };
  }
}
exports.handler = schedule("*/1 * * * *", handler);
