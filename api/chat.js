const MODEL = 'openrouter/free';
const PERSONA = 'Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna.';

const textOf = (turn) =>
  (turn.parts || []).map((p) => p.text || '').join('\n').trim();

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method tidak diizinkan' });

    const candidates = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']
      .map((n) => (process.env[n] || '').trim().replace(/^Bearer\s+/i, ''))
      .filter(Boolean);
    if (candidates.length === 0) return res.status(500).json({ error: 'API key belum diatur di Vercel.' });
    const apiKey = candidates.find((k) => k.startsWith('sk-or-'));
    if (!apiKey) {
      return res.status(500).json({ error: 'Key di Vercel bukan key OpenRouter (harus berawalan sk-or-).' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body) return res.status(400).json({ error: 'Format permintaan salah.' });

    const contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
    if (contents.length === 0) return res.status(400).json({ error: 'Pesan kosong.' });
    if (JSON.stringify(contents).length > 20000) return res.status(413).json({ error: 'Pesan terlalu panjang.' });

    const messages = [
      { role: 'system', content: PERSONA },
      ...contents.map((t) => ({
        role: t.role === 'model' ? 'assistant' : 'user',
        content: textOf(t)
      }))
    ];

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'X-Title': 'GUSTAV.AI'
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 1500 })
    });

    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    if (!r.ok) {
      const msg = (data.error && data.error.message) || raw.slice(0, 200) || 'OpenRouter menolak permintaan.';
      return res.status(r.status).json({ error: '[openrouter] ' + msg });
    }

    const reply = (data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content || '').trim();
    if (!reply) return res.status(502).json({ error: '[openrouter] Model tidak memberi jawaban, coba kirim lagi.' });
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: 'Error di server: ' + (err && err.message ? err.message : err) });
  }
};
