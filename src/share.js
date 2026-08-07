export async function handleShare(request, env) {
  const { content, absurdity } = await request.json();

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const country = request.headers.get("cf-ipcountry") || "ZZ";

  const { alias, color, img_url } = await getAliasColorFromIP(ip);
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO shared_responses
     (content, absurdity_level, ip, country, alias, color, img_url, created_at, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(content, absurdity, ip, country, alias, color, img_url, createdAt, "about")
    .run();

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function hashIP(ip) {
  const msgUint8 = new TextEncoder().encode(ip);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  return [...new Uint8Array(hashBuffer)]
    .slice(0, 6)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
