# Prompt Graph Chat (thin v1)

Minimal chat app for testing prompts against KoboldCPP. Vite + React + TS, plus a tiny Express proxy.

## Run
```bash
npm install
npm run dev            # proxy on 127.0.0.1:5174 + Vite on 0.0.0.0:5173
PORT=5180 PROXY_PORT=5181 KOBOLD_URL=http://192.168.1.10:5001 npm run dev   # overrides
npm run build
```
Open http://localhost:5173. Set the Kobold URL in **Settings** → *Test connection*.

## How it works
- Browser calls `/kobold/*` → Vite proxy → `server/proxy.js` → `<Kobold URL>/*`. The UI's Kobold URL is sent in the
  `X-Kobold-Url` header (falls back to `KOBOLD_URL` env, then `http://localhost:5001`). Unreachable Kobold → HTTP 502 JSON
  `{error:"kobold_unreachable", message}`.
- Generation is a pipeline in `src/pipeline/`: `buildMessages → applyTemplate → trimContext → generate → postProcess`.
  Each step takes/returns a `PipelineContext`; `runPipeline` records a trace (input, output, duration) shown in the
  "pipeline trace" panel. A dry run (skips generate/postProcess) powers the live raw-prompt/token preview.
- Streaming via `/api/extra/generate/stream` with automatic fallback to `/api/v1/generate`; Stop aborts the fetch and
  calls `/api/extra/abort`.
- Token count via `/api/extra/tokencount`, fallback chars/4. Trimming drops oldest messages until
  prompt ≤ max_context_length − max_length; system prompt and latest message are always kept.
- Chats, system prompt, template, custom template, samplers, sampler presets and settings persist in localStorage (`pgc.*`).

## Files
`server/proxy.js`, `src/App.tsx` (UI), `src/kobold.ts` (API client), `src/templates.ts` (Alpaca/ChatML/Llama 3/Mistral),
`src/pipeline/{types,steps,runner}.ts`.

## Text-to-speech
Local TTS (Kokoro-FastAPI or KoboldCPP TTS) can read replies aloud. See [TTS.md](TTS.md) for Windows setup; `start-kokoro.bat` starts Kokoro in Docker.
