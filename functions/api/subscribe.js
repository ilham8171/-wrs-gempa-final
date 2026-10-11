const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

async function keyFor(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!["POST", "DELETE"].includes(request.method)) {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  if (!env.PUSH_SUBSCRIPTIONS) {
    return json({ ok: false, error: "PUSH_SUBSCRIPTIONS KV binding belum tersedia" }, 503);
  }

  try {
    const body = await request.json();
    const sub = body?.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
      return json({ ok: false, error: "subscription tidak valid" }, 400);
    }
    const key = await keyFor(sub.endpoint);
    const storageKey = "sub:" + key;

    if (request.method === "DELETE") {
      await env.PUSH_SUBSCRIPTIONS.delete(storageKey);
      await env.PUSH_SUBSCRIPTIONS.delete("sent:" + key);
      return json({ ok: true, removed: true });
    }

    if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
      return json({ ok: false, error: "subscription keys tidak lengkap" }, 400);
    }
    await env.PUSH_SUBSCRIPTIONS.put(storageKey, JSON.stringify(sub), {
      metadata: { updatedAt: new Date().toISOString() }
    });
    return json({ ok: true, provider: "Cloudflare Pages KV" }, 201);
  } catch (error) {
    console.error("subscribe endpoint failed", error);
    return json({ ok: false, error: "request subscription tidak valid" }, 400);
  }
}
