const MODEL = 'gemini-2.5-flash';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/chat') return env.ASSETS.fetch(request);
    try {
      return await handle(request, env);
    } catch (err) {
      return json({ error: 'Error di server: ' + (err && err.message ? err.message : err) }, 500);
    }
  }
};

async function handle(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method tidak diizinkan' }, 405);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'GEMINI_API_KEY belum diatur.' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Format permintaan salah.' }, 400); }

  const contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
  if (contents.length === 0) return json({ error: 'Pesan kosong.' }, 400);
  if (JSON.stringify(contents).length > 20000) return json({ error: 'Pesan terlalu panjang.' }, 413);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna.' }]
        },
        contents
      })
    }
  );

  const data = await res.json();
  if (!res.ok) return json({ error: (data.error && data.error.message) || 'Gemini menolak permintaan.' }, res.status);

  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const reply = parts.map((p) => p.text || '').join('\n').trim();
  return json({ reply });
}
