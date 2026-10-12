// Tiny proxy: /kobold/* -> <Kobold base URL>/* (X-Kobold-Url header, else KOBOLD_URL env, else localhost:5001)
// and /tts/* -> <TTS base URL>/* (X-TTS-Url header, else TTS_URL env, else localhost:8880).
import express from 'express';
import { Readable } from 'node:stream';
const PORT = Number(process.env.PROXY_PORT || 5174);
const DEFAULT = process.env.KOBOLD_URL || 'http://localhost:5001';
const app = express();
app.use(express.raw({ type: '*/*', limit: '20mb' }));
app.get('/kobold-proxy/health', (_q, r) => r.json({ ok: true, defaultTarget: DEFAULT }));
/** Forward /<prefix>/* to the base URL from header `hdr` (or fallback). Streams the response body (SSE, audio). */
function forward(prefix, hdr, fallback, label) {
  app.all(`/${prefix}/*`, async (req, res) => {
    const base = String(req.headers[hdr] || fallback || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) return res.status(400).json({ error: 'proxy_bad_target', message: `Invalid ${label} URL: ${base || '(empty)'}` });
    const url = base + req.originalUrl.slice(prefix.length + 1);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const up = await fetch(url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*' },
        body: ['GET', 'HEAD'].includes(req.method) || !req.body?.length ? undefined : req.body,
        signal: ac.signal,
      });
      res.status(up.status);
      const ct = up.headers.get('content-type'); if (ct) res.setHeader('content-type', ct);
      res.setHeader('cache-control', 'no-cache');
      if (up.body) Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res); else res.end();
    } catch (e) {
      if (ac.signal.aborted) return;
      res.status(502).json({ error: `${prefix}_unreachable`, target: base,
        message: `Could not reach ${label} at ${base} (${e.cause?.code || e.message}). Is it running?` });
    }
  });
}
forward('kobold', 'x-kobold-url', DEFAULT, 'KoboldCPP');
// TTS: /tts/* -> X-TTS-Url (Kokoro-FastAPI, KoboldCPP TTS, any OpenAI-compatible /v1/audio/speech server)
forward('tts', 'x-tts-url', process.env.TTS_URL || 'http://localhost:8880', 'TTS server');
app.listen(PORT, '127.0.0.1', () => console.log(`[proxy] :${PORT} -> default ${DEFAULT}`));
