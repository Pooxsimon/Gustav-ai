const MODEL = 'openrouter/free';
const PERSONA = 'Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna.';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

const textOf = (turn) =>
  (turn.parts || []).map((p) => p.text || '').join('\n').trim();

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    return json({ error: 'Error di server: ' + (err && err.message ? err.message : err) }, 500);
  }
};

async function handle(req) {
  if (req.method !== 'POST') return json({ error: 'Method tidak diizinkan' }, 405);

  const candidates = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']
    .map((n) => (Netlify.env.get(n) || '').trim().replace(/^Bearer\s+/i, ''))
    .filter(Boolean);
  if (candidates.length === 0) return json({ error: 'API key belum diatur di Netlify.' }, 500);
  const apiKey = candidates.find((k) => k.startsWith('sk-or-'));
  if (!apiKey) {
    return json({ error: 'Key di Netlify bukan key OpenRouter (harus berawalan sk-or-). Cek nilai GEMINI_API_KEY di Netlify.' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Format permintaan salah.' }, 400);
  }

  const contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
  if (contents.length === 0) return json({ error: 'Pesan kosong.' }, 400);
  if (JSON.stringify(contents).length > 20000) return json({ error: 'Pesan terlalu panjang.' }, 413);

  const messages = [
    { role: 'system', content: PERSONA },
    ...contents.map((t) => ({
      role: t.role === 'model' ? 'assistant' : 'user',
      content: textOf(t)
    }))
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'X-Title': 'GUSTAV.AI'
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1500 })
  });

  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}

  if (!res.ok) {
    const msg = (data.error && data.error.message) || raw.slice(0, 200) || 'OpenRouter menolak permintaan.';
    return json({ error: '[openrouter] ' + msg }, res.status);
  }

  const reply = (data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content || '').trim();
  if (!reply) return json({ error: '[openrouter] Model tidak memberi jawaban, coba kirim lagi.' }, 502);
  return json({ reply });
}

export const config = { path: '/api/chat' };
