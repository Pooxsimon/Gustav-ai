// Urutan model: kalau kuota gratis model pertama habis, otomatis pindah ke berikutnya.
// Kuota Gemini dihitung per model, jadi tiap model punya jatah harian sendiri.
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

const SYSTEM_TEXT =
  'Namamu GUSTAV.AI, asisten AI pribadi buatan Gusti. ' +
  'Kalau ditanya siapa kamu, namamu, atau penciptamu, jawab bahwa kamu GUSTAV.AI buatan Gusti. ' +
  'Jangan bilang kamu "model bahasa besar" atau "dilatih oleh Google", dan jangan bilang kamu tidak punya nama. ' +
  'Bersikap ramah dan membantu, dan jawab dalam bahasa yang dipakai pengguna.';

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
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Format permintaan salah.' }, 400);
  }

  let contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
  if (contents.length === 0) return json({ error: 'Pesan kosong.' }, 400);
  if (JSON.stringify(contents).length > 20000) return json({ error: 'Pesan terlalu panjang.' }, 413);

  // Foto dikirim terpisah dari index.html, tempelkan ke pesan terakhir pengguna
  const img = body.image;
  if (img && typeof img.data === 'string' && typeof img.mime_type === 'string' && img.mime_type.startsWith('image/')) {
    if (img.data.length > 6000000) return json({ error: 'Foto terlalu besar, coba foto yang lebih kecil.' }, 413);
    const last = contents.length - 1;
    contents = contents.map((c, i) =>
      i === last
        ? { ...c, parts: [...(c.parts || []), { inline_data: { mime_type: img.mime_type, data: img.data } }] }
        : c
    );
  }

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
    contents
  });

  let lastStatus = 500;
  let sawQuota = false;
  let lastMessage = 'Gemini menolak permintaan.';

  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: payload
      }
    );

    let data = {};
    try {
      data = await res.json();
    } catch {}

    if (res.ok) {
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const reply = parts.map((p) => p.text || '').join('\n').trim();
      return json({ reply });
    }

    lastStatus = res.status;
    if (res.status === 429) sawQuota = true;
    lastMessage = (data.error && data.error.message) || lastMessage;

    // Kuota habis (429), server sibuk (503), atau model tidak tersedia (404): coba model berikutnya
    if (res.status === 429 || res.status === 503 || res.status === 404) continue;

    // Error lain (misalnya key salah) tidak ada gunanya dicoba ulang
    return json({ error: lastMessage }, lastStatus);
  }

  if (sawQuota) {
    return json({ error: 'Kuota gratis hari ini habis. Coba lagi nanti ya.' }, 429);
  }
  return json({ error: 'Layanan AI sedang tidak tersedia. Coba lagi sebentar lagi.' }, 503);
}
