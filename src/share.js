import { getVisitorIdentity } from './visitorIdentity';

export async function handleShare(request, env) {
  const { content, absurdity, visitorId } = await request.json();
  if (typeof content !== 'string' || !content.trim() || !Number.isFinite(Number(absurdity))) {
    return new Response(JSON.stringify({ error: 'Invalid shared response.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  const visitorKey = typeof visitorId === 'string' && visitorId.trim()
    ? visitorId.slice(0, 100)
    : request.headers.get('cf-connecting-ip') || crypto.randomUUID();
  const country = request.cf?.country || request.headers.get('cf-ipcountry') || 'ZZ';
  const { alias, color, img_url } = await getVisitorIdentity(visitorKey, env);
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO shared_responses
     (content, absurdity_level, ip, country, alias, color, img_url, created_at, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(content, absurdity, null, country, alias, color, img_url, createdAt, 'about')
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
