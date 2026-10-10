const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

function keyFor(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  }
  if (!["POST", "DELETE"].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "method not allowed" }) };
  }
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "subscription tidak valid" }) };
    }
    const store = getStore("push-subscriptions");
    const key = keyFor(sub.endpoint);
    if (event.httpMethod === "DELETE") {
      await store.delete(key);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: true }) };
    }
    if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "subscription keys tidak lengkap" }) };
    }
    await store.setJSON(key, sub);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    console.error("subscribe endpoint failed", error);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "subscription gagal disimpan" }) };
  }
};
