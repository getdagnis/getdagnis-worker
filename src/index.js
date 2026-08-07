import { ASK_AI_PROMPT_DATA } from './prompt';
import { ASK_AI_ABSURD_PROMPTS } from './absurdPrompts';
import { handleShare } from './share';

const referers = ['https://getdagnis-1.vercel.app', 'https://getdagnis-2.vercel.app', 'https://getdagnis-3.vercel.app'];
const TEAM_VOTE_OPTIONS = new Set(['ok', 'perfect']);

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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
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

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO team_vote_events (vote, duration_ms, visitor_id, country, device)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(vote, Math.round(normalizedDurationMs), normalizedVisitorId, country, device),
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
        `SELECT id,content,absurdity_level,alias,created_at,type FROM shared_responses ORDER BY created_at DESC`
      ).all();
      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (url.pathname === '/team-votes') {
      return handleTeamVotes(request, env);
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
        const keysEnv = env.OPENROUTER_KEYS || '';
        const keys = keysEnv
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
        if (keys.length === 0) {
          console.error('No OPENROUTER_KEYS configured.');
          return new Response(JSON.stringify({ error: 'No OPENROUTER_KEYS configured.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        let lastErrorText = null;
        const apologyRegex = /sorry|cannot fulfill|cannot comply|cannot complete|unable to comply/i;

        // Helper that tries all keys with a given prompt and returns a structured result
        async function tryWithPrompt(prompt) {
          let lastErr = null;
          let refused = false;
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const referer = referers[i] || '';
            try {
              const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${key}`,
                  'Content-Type': 'application/json',
                  Referer: referer,
                  'X-Title': 'getdagnis',
                },
                body: JSON.stringify({
                  model: 'openai/gpt-4o-mini',
                  messages: [{ role: 'user', content: prompt }],
                  temperature: 0.9,
                }),
              });

              if (res.status === 429) {
                console.warn(`Key ${key.slice(0, 12)}... rate limited.`);
                lastErr = await res.text().catch(() => null);
                continue;
              }

              let json = null;
              try {
                json = await res.json();
              } catch (parseErr) {
                const txt = await res.text().catch(() => null);
                console.error(`Key ${key.slice(0, 12)} returned non-JSON response:`, txt || parseErr);
                lastErr = txt || String(parseErr);
                if (txt && apologyRegex.test(txt)) refused = true;
                continue;
              }

              if (json.choices?.[0]?.message?.content) {
                const content = json.choices[0].message.content;
                if (apologyRegex.test(content)) {
                  console.warn(`Key ${key.slice(0, 12)} returned refusal content:`, content);
                  refused = true;
                  lastErr = content;
                  continue;
                }

                return { ok: true, content };
              }

              if (json.error || json.message) {
                const txt = JSON.stringify(json);
                console.warn(`Key ${key.slice(0, 12)} returned provider error:`, json);
                lastErr = txt;
                if (apologyRegex.test(txt)) refused = true;
                continue;
              }
            } catch (err) {
              console.error(`Key ${key.slice(0, 12)}... failed`, err);
              lastErr = String(err);
              continue;
            }
          }

          return { ok: false, refused, lastErr };
        }

        // Try original prompt
        const first = await tryWithPrompt(fullPrompt);
        if (first.ok) {
          return new Response(JSON.stringify({ content: first.content }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        // If provider refused, attempt one gentle retry with an explicitly fictionalized prompt
        if (first.refused) {
          console.warn('Provider refused first prompt; attempting a fictionalized retry');
          const sanitizedPrompt = `This is a fictional spy-story. The subject should be treated as a fictional person and no real-world allegations should be made. ${fullPrompt}`;
          const retry = await tryWithPrompt(sanitizedPrompt);
          if (retry.ok) {
            return new Response(JSON.stringify({ content: retry.content }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
          }

          return new Response(
            JSON.stringify({
              error: 'Provider refused to fulfill the request.',
              suggestion: 'Please try again (the model may be transiently unable to fulfill that prompt).',
              details: first.lastErr,
              retryAttempted: true,
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            }
          );
        }

        // Otherwise report rate-limit/failure
        return new Response(
          JSON.stringify({ error: 'All API keys failed or were rate-limited.', details: first.lastErr }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          }
        );
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
