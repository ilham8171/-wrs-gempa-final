const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};
function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}
function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function getOrCreateKeys(kv) {
  const [privateText, publicKey] = await Promise.all([
    kv.get("vapid:private"),
    kv.get("vapid:public")
  ]);
  if (privateText && publicKey) return publicKey;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicValue = b64url(publicRaw);
  // Keep the private key server-side; never include it in an API response.
  await kv.put("vapid:private", JSON.stringify(privateJwk));
  await kv.put("vapid:public", publicValue);
  return publicValue;
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers });
}
export async function onRequest({ request, env }) {
  if (request.method !== "GET") return response({ ok: false, error: "method not allowed" }, 405);
  if (!env.PUSH_SUBSCRIPTIONS) return response({ ok: false, error: "push storage belum dikonfigurasi" }, 503);
  try {
    const publicKey = await getOrCreateKeys(env.PUSH_SUBSCRIPTIONS);
    return response({ ok: true, publicKey });
  } catch (error) {
    console.error("push key initialization failed", error);
    return response({ ok: false, error: "kunci push belum dapat disiapkan" }, 503);
  }
}
