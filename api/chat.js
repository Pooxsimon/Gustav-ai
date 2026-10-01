// Vercel function: Gemini dulu (dengan beberapa model cadangan), lalu OpenRouter sebagai cadangan terakhir.
// Jawaban dikirim bertahap (streaming) supaya teks langsung muncul. Key disimpan di Vercel, tidak pernah ke browser.
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];
const OPENROUTER_MODEL = "openrouter/free";
const PERSONA =
  "Kamu adalah GUSTAV.AI, asisten AI yang ramah dan membantu. Jawab dalam bahasa yang dipakai pengguna. Format jawaban rapi dan singkat: boleh pakai **tebal** dan daftar bernomor. Tulis rumus matematika dengan simbol biasa (contoh: 2/9, \u00f7, \u00d7, x\u00b2, \u221a16) dan jangan pakai LaTeX atau tanda dolar. Kalau ada foto, baca isinya dengan teliti lalu jawab langkah demi langkah.";

const textOf = (turn) =>
  (turn.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

const clean = (v) => (v || "").trim().replace(/^Bearer\s+/i, "");

// Membaca aliran SSE (baris "data: ...") dan mengeluarkan isi data satu per satu
async function* readSSE(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const dataOf = (block) =>
    block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const d = dataOf(block);
      if (d) yield d;
    }
  }
  const tail = dataOf(buf);
  if (tail) yield tail;
}

async function* geminiStream(key, contents, image) {
  const last = contents[contents.length - 1];
  const history = contents
    .slice(0, -1)
    .map((t) => (t.role === "model" ? "GUSTAV.AI: " : "Pengguna: ") + textOf(t))
    .join("\n");
  const input =
    PERSONA +
    "\n\n" +
    (history ? "Riwayat percakapan sebelumnya:\n" + history + "\n\n" : "") +
    "Pesan terbaru dari pengguna (jawab yang ini):\n" +
    textOf(last);
  const payloadInput = image
    ? [
        { type: "text", text: input },
        { type: "image", data: image.data, mime_type: image.mime_type },
      ]
    : input;

  let lastErr = new Error("[gemini] Gagal.");
  for (const model of GEMINI_MODELS) {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({ model, input: payloadInput, stream: true }),
      }
    );
    if (!r.ok) {
      const raw = await r.text();
      let data = {};
      try {
        data = JSON.parse(raw);
      } catch {}
      lastErr = new Error(
        "[gemini] " +
          ((data.error && data.error.message) || raw.slice(0, 200) || "ditolak")
      );
      lastErr.status = r.status;
      if (r.status === 401 || r.status === 403) break; // masalah key, ganti model tidak membantu
      continue;
    }
    let produced = false;
    try {
      for await (const d of readSSE(r.body)) {
        let ev;
        try {
          ev = JSON.parse(d);
        } catch {
          continue;
        }
        if (ev.error)
          throw new Error(
            "[gemini] " + (ev.error.message || "error saat streaming")
          );
        if (
          ev.event_type === "step.delta" &&
          ev.delta &&
          ev.delta.type === "text" &&
          ev.delta.text
        ) {
          produced = true;
          yield ev.delta.text;
        }
      }
    } catch (e) {
      if (produced) throw e; // sudah ada teks terkirim, tidak bisa ganti model lagi
      lastErr = e;
      continue;
    }
    if (produced) return;
    lastErr = new Error("[gemini] Tidak ada jawaban dari model.");
  }
  throw lastErr;
}

async function* openrouterStream(key, contents, image) {
  const messages = [
    { role: "system", content: PERSONA },
    ...contents.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: textOf(t),
    })),
  ];
  if (image) {
    const lastMsg = messages[messages.length - 1];
    lastMsg.content = [
      { type: "text", text: lastMsg.content },
      {
        type: "image_url",
        image_url: { url: "data:" + image.mime_type + ";base64," + image.data },
      },
    ];
  }
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      "X-Title": "GUSTAV.AI",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 1500,
      stream: true,
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}
    throw new Error(
      "[openrouter] " +
        ((data.error && data.error.message) || raw.slice(0, 200) || "ditolak")
    );
  }
  for await (const d of readSSE(r.body)) {
    if (d === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(d);
    } catch {
      continue;
    }
    if (ev.error)
      throw new Error(
        "[openrouter] " + (ev.error.message || "error saat streaming")
      );
    const t =
      ev.choices &&
      ev.choices[0] &&
      ev.choices[0].delta &&
      ev.choices[0].delta.content;
    if (typeof t === "string" && t) yield t;
  }
}

// Jalankan Gemini, kalau gagal sebelum ada teks, pindah ke OpenRouter. emit(t) dipanggil tiap potongan teks.
async function run(gemKey, orKey, contents, image, emit) {
  let produced = false;
  const attempt = async (gen) => {
    for await (const t of gen) {
      produced = true;
      emit(t);
    }
  };
  let gemError = null;
  if (gemKey) {
    try {
      await attempt(geminiStream(gemKey, contents, image));
      if (produced) return;
      gemError = new Error("[gemini] Tidak ada jawaban dari model.");
    } catch (e) {
      if (produced) throw e;
      gemError = e;
    }
  }
  if (orKey) {
    try {
      await attempt(openrouterStream(orKey, contents, image));
      if (produced) return;
      throw new Error(
        "[openrouter] Model tidak memberi jawaban, coba kirim lagi."
      );
    } catch (e) {
      if (produced) throw e;
      throw new Error((gemError ? gemError.message + " | " : "") + e.message);
    }
  }
  throw gemError;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method tidak diizinkan" });

    const all = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY"]
      .map((n) => clean(process.env[n]))
      .filter(Boolean);
    const orKey = all.find((k) => k.startsWith("sk-or-"));
    const gemKey = all.find((k) => !k.startsWith("sk-or-"));
    if (!orKey && !gemKey)
      return res.status(500).json({ error: "API key belum diatur di Vercel." });

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    if (!body)
      return res.status(400).json({ error: "Format permintaan salah." });

    const contents = Array.isArray(body.contents)
      ? body.contents.slice(-20)
      : [];
    if (contents.length === 0)
      return res.status(400).json({ error: "Pesan kosong." });
    if (JSON.stringify(contents).length > 20000)
      return res.status(413).json({ error: "Pesan terlalu panjang." });

    let image = null;
    if (body.image && typeof body.image.data === "string") {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(
          body.image.mime_type
        )
      ) {
        return res
          .status(400)
          .json({
            error: "Format foto tidak didukung (pakai JPG, PNG, atau WEBP).",
          });
      }
      if (body.image.data.length > 4000000)
        return res.status(413).json({ error: "Foto terlalu besar." });
      image = { mime_type: body.image.mime_type, data: body.image.data };
    }

    if (body.stream) {
      // Kirim bertahap: satu baris JSON per potongan: {"t":"teks"} atau {"error":"..."}
      let started = false;
      const send = (obj) => {
        if (!started) {
          started = true;
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("X-Accel-Buffering", "no");
          if (res.flushHeaders) res.flushHeaders();
        }
        res.write(JSON.stringify(obj) + "\n");
      };
      try {
        await run(gemKey, orKey, contents, image, (t) => send({ t }));
        return res.end();
      } catch (e) {
        if (started) {
          send({ error: e.message });
          return res.end();
        }
        return res.status(502).json({ error: e.message });
      }
    }

    let text = "";
    try {
      await run(gemKey, orKey, contents, image, (t) => {
        text += t;
      });
      return res.status(200).json({ reply: text.trim() });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  } catch (err) {
    return res
      .status(500)
      .json({
        error: "Error di server: " + (err && err.message ? err.message : err),
      });
  }
};
