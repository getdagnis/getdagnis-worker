import { ASK_AI_PROMPT_DATA } from './prompt';
import { ASK_AI_ABSURD_PROMPTS } from './absurdPrompts';
import { handleShare } from './share';
import { getVisitorIdentity } from './visitorIdentity';

export const CLOUDFLARE_MODEL = '@cf/zai-org/glm-4.7-flash';
const TEAM_VOTE_OPTIONS = new Set(['ok', 'perfect']);
const ARCHIVE_PROJECT_KEYS = new Set([
  'yearbook', 'reformu', 'open', '5g', 'binders', 'summer', 'positivus', 'haemo', 'api',
  'bb-wake', 'royal', 'sporta', 'var', 'lapas', 'latvija', 'rsu', 'saistoss', 'maritec',
  'creative', 'survival', 'guw', 'useless', 'kiki', 'urban', 'zagars', 'gagarin', 'atlant',
]);

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function getDeviceType(userAgent = '') {
  if (/iPad/i.test(userAgent)) return 'tablet/ipad';
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? 'phone/android' : 'tablet/android';
  if (/iPhone/i.test(userAgent)) return 'phone/iphone';
  if (/Windows/i.test(userAgent)) return 'computer/windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'computer/mac';
  if (/Linux/i.test(userAgent)) return 'computer/linux';
  return 'other';
}

function isLocalhostOrigin(origin) {
  try {
    const hostname = origin ? new URL(origin).hostname : '';
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function ensureTeamVotesTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS team_votes (
      vote TEXT PRIMARY KEY CHECK (vote IN ('ok', 'perfect')),
      count INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO team_votes (vote, count) VALUES ('ok', 0)`),
    env.DB.prepare(`INSERT OR IGNORE INTO team_votes (vote, count) VALUES ('perfect', 0)`),
  ]);
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS team_vote_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote TEXT NOT NULL CHECK (vote IN ('ok', 'perfect')),
      duration_ms INTEGER NOT NULL,
      visitor_id TEXT,
      country TEXT,
      device TEXT NOT NULL,
      visitor_alias TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
  try {
    await env.DB.prepare('ALTER TABLE team_vote_events ADD COLUMN visitor_alias TEXT').run();
  } catch {
    // The column already exists on databases initialized before this version.
  }
}

async function handleTeamVotes(request, env) {
  await ensureTeamVotesTable(env);

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT vote, count FROM team_votes`).all();
    const counts = results.reduce((current, row) => ({ ...current, [row.vote]: Number(row.count) || 0 }), {
      ok: 0,
      perfect: 0,
    });
    return new Response(JSON.stringify(counts), { headers: jsonHeaders });
  }

  if (request.method === 'POST') {
    if (isLocalhostOrigin(request.headers.get('Origin'))) {
      return new Response(JSON.stringify({ error: 'Team votes are disabled on localhost.' }), {
        status: 403,
        headers: jsonHeaders,
      });
    }

    let vote;
    let durationMs;
    let visitorId;
    try {
      ({ vote, durationMs, visitorId } = await request.json());
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request.' }), { status: 400, headers: jsonHeaders });
    }

    if (!TEAM_VOTE_OPTIONS.has(vote)) {
      return new Response(JSON.stringify({ error: 'Invalid team vote.' }), { status: 400, headers: jsonHeaders });
    }

    const normalizedDurationMs = Number(durationMs);
    if (!Number.isFinite(normalizedDurationMs) || normalizedDurationMs < 0) {
      return new Response(JSON.stringify({ error: 'Invalid vote duration.' }), { status: 400, headers: jsonHeaders });
    }

    const normalizedVisitorId = typeof visitorId === 'string' ? visitorId.slice(0, 100) : null;
    const country = request.cf?.country || null;
    const device = getDeviceType(request.headers.get('User-Agent') || '');
    const { alias, color } = await getVisitorIdentity(normalizedVisitorId || crypto.randomUUID(), env);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO team_vote_events (vote, duration_ms, visitor_id, country, device, visitor_alias)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(vote, Math.round(normalizedDurationMs), normalizedVisitorId, country, device, `${color} ${alias}`),
      env.DB.prepare(`UPDATE team_votes SET count = count + 1 WHERE vote = ?`).bind(vote),
    ]);
    const { results } = await env.DB.prepare(`SELECT vote, count FROM team_votes`).all();
    const counts = results.reduce((current, row) => ({ ...current, [row.vote]: Number(row.count) || 0 }), {
      ok: 0,
      perfect: 0,
    });
    return new Response(JSON.stringify(counts), { headers: jsonHeaders });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
    status: 405,
    headers: { ...jsonHeaders, Allow: 'GET, POST, OPTIONS' },
  });
}

async function ensureArchiveVotesTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS archive_votes (
      project_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
}

async function ensureArchiveCommentsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS archive_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      email TEXT,
      country TEXT,
      device TEXT NOT NULL,
      timezone TEXT,
      submitted_at_riga TEXT NOT NULL
    )`
  ).run();
}

function getRigaTimestamp() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

async function handleArchiveVotes(request, env) {
  await ensureArchiveVotesTable(env);

  if (request.method === 'GET') {
    const projectKey = new URL(request.url).searchParams.get('projectKey');
    if (!ARCHIVE_PROJECT_KEYS.has(projectKey)) {
      return new Response(JSON.stringify({ error: 'Invalid archive project.' }), { status: 400, headers: jsonHeaders });
    }

    const row = await env.DB.prepare('SELECT count FROM archive_votes WHERE project_key = ?').bind(projectKey).first();
    return new Response(JSON.stringify({ count: Number(row?.count) || 0 }), { headers: jsonHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'POST, OPTIONS' },
    });
  }

  let projectKey;
  try {
    ({ projectKey } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request.' }), { status: 400, headers: jsonHeaders });
  }

  if (typeof projectKey !== 'string' || !ARCHIVE_PROJECT_KEYS.has(projectKey)) {
    return new Response(JSON.stringify({ error: 'Invalid archive project.' }), { status: 400, headers: jsonHeaders });
  }

  await env.DB.prepare(
    `INSERT INTO archive_votes (project_key, count) VALUES (?, 1)
     ON CONFLICT(project_key) DO UPDATE SET count = archive_votes.count + 1`
  ).bind(projectKey).run();

  return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
}

async function handleArchiveComments(request, env) {
  await ensureArchiveCommentsTable(env);

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'POST, OPTIONS' },
    });
  }

  let projectKey;
  let reason;
  let email;
  let timezone;
  try {
    ({ projectKey, reason, email, timezone } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request.' }), { status: 400, headers: jsonHeaders });
  }

  const normalizedReason = typeof reason === 'string' ? reason.trim().slice(0, 5000) : '';
  const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().slice(0, 320) : null;
  const normalizedTimezone = typeof timezone === 'string' ? timezone.slice(0, 100) : null;

  if (!ARCHIVE_PROJECT_KEYS.has(projectKey) || normalizedReason.length < 6) {
    return new Response(JSON.stringify({ error: 'Invalid archive comment.' }), { status: 400, headers: jsonHeaders });
  }

  const country = request.cf?.country || null;
  const device = getDeviceType(request.headers.get('User-Agent') || '');
  const submittedAt = getRigaTimestamp();

  await env.DB.prepare(
    `INSERT INTO archive_comments
      (project_key, reason, email, country, device, timezone, submitted_at_riga)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(projectKey, normalizedReason, normalizedEmail, country, device, normalizedTimezone, submittedAt).run();

  return new Response(JSON.stringify({
    success: true,
    country,
    device,
    submittedAt,
  }), { headers: jsonHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (url.pathname === '/shared' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT id,content,absurdity_level,alias,color,img_url,country,created_at,type FROM shared_responses ORDER BY created_at DESC`
      ).all();
      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (url.pathname === '/team-votes') {
      return handleTeamVotes(request, env);
    }
    if (url.pathname === '/archive-votes') {
      return handleArchiveVotes(request, env);
    }
    if (url.pathname === '/archive-comments') {
      return handleArchiveComments(request, env);
    }
    if (url.pathname === '/share' && request.method === 'POST') {
      return handleShare(request, env);
    }
    if (request.method === 'POST') {
      try {
        const { absurdity } = await request.json();
        const absurdPrompt = ASK_AI_ABSURD_PROMPTS.find((p) => p.absurdityLevel === String(absurdity));
        if (!absurdPrompt) {
          console.error(
            'Available levels:',
            ASK_AI_ABSURD_PROMPTS.map((p) => p.absurdityLevel)
          );
          return new Response(JSON.stringify({ error: 'Invalid absurdity level.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
        const fullPrompt = `${ASK_AI_PROMPT_DATA.trim()} "${absurdPrompt.prompt}"`;
        const result = await env.AI.run(CLOUDFLARE_MODEL, {
          messages: [{ role: 'user', content: fullPrompt }],
          max_tokens: 600,
          temperature: 0.9,
        });
        const content = result?.response ?? result?.choices?.[0]?.message?.content;

        if (typeof content !== 'string' || !content.trim()) {
          console.error('Cloudflare AI returned no generated content.', result);
          return new Response(JSON.stringify({ error: 'Cloudflare AI returned no generated content.' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        return new Response(JSON.stringify({ content }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        console.error('Parse error or bad JSON:', err);
        return new Response(JSON.stringify({ error: 'Invalid request.', details: String(err) }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  },
};
