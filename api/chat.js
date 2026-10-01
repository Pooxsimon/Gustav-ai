// Vercel function: coba Gemini dulu (cepat), kalau gagal pakai OpenRouter sebagai cadangan.
// API key disimpan di Vercel (Environment Variables), tidak pernah dikirim ke browser.
// Kalau satu model sedang penuh (503), otomatis coba model berikutnya
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const OPENROUTER_MODEL = 'openrouter/free';
const PERSONA = 'Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna. Format jawaban rapi dan singkat: boleh pakai **tebal** dan daftar bernomor. Tulis rumus matematika dengan simbol biasa (contoh: 2/9, ÷, ×, x², √16) dan jangan pakai LaTeX atau tanda dolar. Kalau ada foto, baca isinya dengan teliti lalu jawab langkah demi langkah.';

const textOf = (turn) =>
  (turn.parts || []).map((p) => p.text || '').join('\n').trim();

const clean = (v) => (v || '').trim().replace(/^Bearer\s+/i, '');

function extractGemini(d) {
  if (typeof d.output_text === 'string' && d.output_text) return d.output_text;
  const texts = [];
  for (const s of Array.isArray(d.steps) ? d.steps : []) {
    if (s.type === 'model_output' && Array.isArray(s.content)) {
      for (const c of s.content) if (c.type === 'text' && c.text) texts.push(c.text);
    }
  }
  if (texts.length) return texts.join('\n');
  return (Array.isArray(d.outputs) ? d.outputs : [])
    .filter((o) => o.type === 'text' && o.text)
    .map((o) => o.text)
    .join('\n');
}

async function askGemini(key, contents, image) {
  const last = contents[contents.length - 1];
  const history = contents.slice(0, -1)
    .map((t) => (t.role === 'model' ? 'GUSTAV.AI: ' : 'Pengguna: ') + textOf(t))
    .join('\n');
  const input =
    PERSONA + '\n\n' +
    (history ? 'Riwayat percakapan sebelumnya:\n' + history + '\n\n' : '') +
    'Pesan terbaru dari pengguna (jawab yang ini):\n' + textOf(last);

  const payloadInput = image
    ? [{ type: 'text', text: input }, { type: 'image', data: image.data, mime_type: image.mime_type }]
    : input;

  let lastErr = new Error('[gemini] Gagal.');
  for (const model of GEMINI_MODELS) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({ model, input: payloadInput })
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (r.ok) {
      const reply = extractGemini(data).trim();
      if (reply) return reply;
      lastErr = new Error('[gemini] Tidak ada jawaban dari model.');
      continue;
    }
    lastErr = new Error('[gemini] ' + ((data.error && data.error.message) || raw.slice(0, 200) || 'ditolak'));
    lastErr.status = r.status;
    if (r.status === 401 || r.status === 403) break; // masalah key, ganti model tidak membantu
  }
  throw lastErr;
}

async function askOpenRouter(key, contents, image) {
  const messages = [
    { role: 'system', content: PERSONA },
    ...contents.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: textOf(t) }))
  ];
  if (image) {
    const lastMsg = messages[messages.length - 1];
    lastMsg.content = [
      { type: 'text', text: lastMsg.content },
      { type: 'image_url', image_url: { url: 'data:' + image.mime_type + ';base64,' + image.data } }
    ];
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'X-Title': 'GUSTAV.AI' },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 1500 })
  });
  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!r.ok) throw new Error('[openrouter] ' + ((data.error && data.error.message) || raw.slice(0, 200) || 'ditolak'));
  const reply = (data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content || '').trim();
  if (!reply) throw new Error('[openrouter] Model tidak memberi jawaban, coba kirim lagi.');
  return reply;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method tidak diizinkan' });

    const all = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']
      .map((n) => clean(process.env[n])).filter(Boolean);
    const orKey = all.find((k) => k.startsWith('sk-or-'));
    const gemKey = all.find((k) => !k.startsWith('sk-or-'));
    if (!orKey && !gemKey) return res.status(500).json({ error: 'API key belum diatur di Vercel.' });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body) return res.status(400).json({ error: 'Format permintaan salah.' });

    const contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
    if (contents.length === 0) return res.status(400).json({ error: 'Pesan kosong.' });
    if (JSON.stringify(contents).length > 20000) return res.status(413).json({ error: 'Pesan terlalu panjang.' });

    let image = null;
    if (body.image && typeof body.image.data === 'string') {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(body.image.mime_type)) {
        return res.status(400).json({ error: 'Format foto tidak didukung (pakai JPG, PNG, atau WEBP).' });
      }
      if (body.image.data.length > 4000000) return res.status(413).json({ error: 'Foto terlalu besar.' });
      image = { mime_type: body.image.mime_type, data: body.image.data };
    }

    let gemError = null;
    if (gemKey) {
      try {
        return res.status(200).json({ reply: await askGemini(gemKey, contents, image) });
      } catch (e) {
        gemError = e;
        if (!orKey) return res.status(502).json({ error: e.message });
      }
    }
    try {
      return res.status(200).json({ reply: await askOpenRouter(orKey, contents, image) });
    } catch (e) {
      return res.status(502).json({ error: (gemError ? gemError.message + ' | ' : '') + e.message });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Error di server: ' + (err && err.message ? err.message : err) });
  }
};
