import { timingSafeEqual } from 'node:crypto';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

function equalCode(received, expected) {
  const a = Buffer.from(received || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function POST(request) {
  const key = process.env.DEEPSEEK_API_KEY;
  const code = process.env.EUREKA_DEMO_CODE;
  if (!key || !code) return json({ error: 'Konfigurasi demo belum lengkap di server.' }, 503);
  if (!equalCode(request.headers.get('x-eureka-demo-code'), code)) {
    return json({ error: 'Kode akses demo tidak cocok.' }, 401);
  }

  const maxBytes = 6 * 1024 * 1024;
  if (Number(request.headers.get('content-length') || 0) > maxBytes) {
    return json({ error: 'Materi terlalu besar.' }, 413);
  }
  let raw = '';
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Permintaan kosong.' }, 400);
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); return json({ error: 'Materi terlalu besar.' }, 413); }
      chunks.push(value);
    }
    raw = Buffer.concat(chunks, bytes).toString('utf8');
  } catch { return json({ error: 'Permintaan tidak dapat dibaca.' }, 400); }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Format permintaan tidak valid.' }, 400); }
  const allowedModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);
  const validMessages = body && Array.isArray(body.messages) && body.messages.length >= 2 && body.messages.length <= 26 &&
    body.messages[0]?.role === 'system' &&
    body.messages.every(m => m && ['system', 'user', 'assistant'].includes(m.role) &&
      (typeof m.content === 'string' || Array.isArray(m.content)));
  if (!allowedModels.has(body?.model) || !validMessages) {
    return json({ error: 'Model atau format pesan tidak valid.' }, 400);
  }

  const payload = {
    model: body.model,
    messages: body.messages,
    stream: false,
    max_tokens: 4096,
    ...(body.response_format?.type === 'json_object' ? { response_format: { type: 'json_object' } } : {})
  };
  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      return json({ error: data?.error?.message || 'DeepSeek menolak permintaan.' }, upstream.status);
    }
    return json({ choices: [{ message: { content: data.choices?.[0]?.message?.content || '' }, finish_reason: data.choices?.[0]?.finish_reason || null }] });
  } catch {
    return json({ error: 'Server gagal menghubungi DeepSeek. Coba lagi.' }, 502);
  }
}
