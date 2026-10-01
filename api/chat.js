const GEMINI_MODEL = 'gemini-3.8-flash';
const OPENROUTER_MODEL = 'openrouter/free';
const PERSONA = 'Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna.';

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

async function askGemini(key, contents) {
  const last = contents[contents.length - 1];
  const history = contents.slice(0, -1)
    .map((t) => (t.role === 'model' ? 'GUSTAV.AI: ' : 'Pengguna: ') + textOf(t))
    .join('\n');
  const input =
    PERSONA + '\n\n' +
    (history ? 'Riwayat percakapan sebelumnya:\n' + history + '\n\n' : '') +
    'Pesan terbaru dari pengguna (jawab yang ini):\n' + textOf(last);

  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
    body: JSON.stringify({ model: GEMINI_MODEL, input })
  });
  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!r.ok) throw new Error('[gemini] ' + ((data.error && data.error.message) || raw.slice(0, 200) || 'ditolak'));
  const reply = extractGemini(data).trim();
  if (!reply) throw new Error('[gemini] Tidak ada jawaban dari model.');
  return reply;
}

async function askOpenRouter(key, contents) {
  const messages = [
    { role: 'system', content: PERSONA },
    ...contents.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: textOf(t) }))
  ];
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

    let gemError = null;
    if (gemKey) {
      try {
        return res.status(200).json({ reply: await askGemini(gemKey, contents) });
      } catch (e) {
        gemError = e;
        if (!orKey) return res.status(502).json({ error: e.message });
      }
    }
    try {
      return res.status(200).json({ reply: await askOpenRouter(orKey, contents) });
    } catch (e) {
      return res.status(502).json({ error: (gemError ? gemError.message + ' | ' : '') + e.message });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Error di server: ' + (err && err.message ? err.message : err) });
  }
};
