/**
 * Simpan / hapus push subscription (Web Push) di Netlify Blobs, supaya
 * notifikasi gempa tetap bisa masuk walau tab/browser tidak dibuka
 * (dikirim oleh scheduled function check-quakes-push.js).
 */
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

function keyFor(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  try {
    const store = getStore("push-subscriptions");
    const body = event.body ? JSON.parse(event.body) : {};
    const sub = body.subscription;
    if (!sub?.endpoint) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "subscription tidak valid" }) };
    }
    const key = keyFor(sub.endpoint);

    if (event.httpMethod === "DELETE") {
      await store.delete(key);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: true }) };
    }

    await store.setJSON(key, sub);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
