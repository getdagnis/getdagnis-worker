import { ASK_AI_PROMPT_DATA } from './prompt';
import { ASK_AI_ABSURD_PROMPTS } from './absurdPrompts';
import { handleShare } from './share';

const referers = ['https://getdagnis-1.vercel.app', 'https://getdagnis-2.vercel.app', 'https://getdagnis-3.vercel.app'];

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
