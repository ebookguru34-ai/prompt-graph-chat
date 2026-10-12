// Browser-side KoboldCPP client; all calls go through the /kobold proxy with the target in X-Kobold-Url.
export class KoboldError extends Error {}
const headers = (base: string) => ({ 'content-type': 'application/json', 'x-kobold-url': base });

async function req(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  let r: Response;
  try { r = await fetch('/kobold' + path, { ...init, headers: { ...headers(base), ...(init.headers || {}) } }); }
  catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new KoboldError('Local proxy is not reachable. Is `npm run dev` running?');
  }
  if (!r.ok) {
    let msg = `Kobold returned HTTP ${r.status}`;
    try { const j = await r.clone().json(); msg = j.message || j.detail?.msg || j.error || msg; } catch { /* ignore */ }
    throw new KoboldError(msg);
  }
  return r;
}
export async function getModel(base: string): Promise<string> {
  const j = await (await req(base, '/api/v1/model')).json(); return j.result ?? JSON.stringify(j);
}
export async function tokenCount(base: string, prompt: string): Promise<number> {
  const j = await (await req(base, '/api/extra/tokencount', { method: 'POST', body: JSON.stringify({ prompt }) })).json();
  if (typeof j.value !== 'number') throw new KoboldError('Bad tokencount response'); return j.value;
}
export async function abort(base: string) {
  try { await req(base, '/api/extra/abort', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
}
export async function generate(base: string, body: object, signal?: AbortSignal): Promise<string> {
  const j = await (await req(base, '/api/v1/generate', { method: 'POST', body: JSON.stringify(body), signal })).json();
  return j.results?.[0]?.text ?? '';
}
/** SSE streaming. Calls onToken per token; resolves with full text. */
export async function generateStream(base: string, body: object, onToken: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const r = await req(base, '/api/extra/generate/stream', { method: 'POST', body: JSON.stringify(body), signal });
  if (!r.body) throw new KoboldError('No stream body');
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', full = '', gotAny = false;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split(/\r?\n\r?\n/); buf = events.pop() ?? '';
    for (const ev of events) for (const line of ev.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const d = JSON.parse(line.slice(5).trim()); if (typeof d.token === 'string') { gotAny = true; full += d.token; onToken(d.token); } }
      catch { /* ignore */ }
    }
  }
  if (!gotAny && !full) { /* empty but valid stream is allowed */ }
  return full;
}
/** Embeddings via KoboldCPP's OpenAI-compatible /v1/embeddings (needs an embeddings model loaded). */
export async function embeddings(base: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
  const j = await (await req(base, '/v1/embeddings', { method: 'POST', body: JSON.stringify({ model: 'kcpp', input }), signal })).json();
  const data = (j.data ?? []) as { embedding: number[]; index?: number }[];
  if (data.length !== input.length || !data.every((d) => Array.isArray(d.embedding))) throw new KoboldError('Embeddings response malformed');
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}
