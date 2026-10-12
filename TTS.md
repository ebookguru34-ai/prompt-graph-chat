# Local text-to-speech (TTS)

The app reads replies aloud through any **OpenAI-compatible** speech server (`POST /v1/audio/speech`).
All audio goes through the app's local proxy (`/tts/*`), so it also works when you open the app on your phone over Tailscale. The TTS server only has to be reachable from the **PC** that runs the app, so `http://localhost:...` is fine.

Turn it on under **⚙ → Settings → Text-to-speech**: tick *Enable TTS*, pick a backend, press ↻ to load voices, then press **Test voice**.

## Option A: Kokoro-FastAPI (recommended, fast, good quality)

### With Docker Desktop (Windows)
1. Install Docker Desktop and start it.
2. Run one of these (or double-click `start-kokoro.bat`):
   - CPU: `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`
   - NVIDIA GPU: `docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest`
3. Wait until it says it's ready, then check http://localhost:8880/docs (or the web UI at http://localhost:8880/web).
4. In the app: Backend **Kokoro-FastAPI**, URL `http://localhost:8880`, voice e.g. `af_heart`, `af_bella`, `am_adam`, `bf_emma`, `bm_george`.

### Without Docker
1. Install Git and Python, plus [uv](https://docs.astral.sh/uv/) (`pip install uv`).
2. `git clone https://github.com/remsky/Kokoro-FastAPI.git` and `cd Kokoro-FastAPI`
3. In PowerShell run `.\start-cpu.ps1` (or `.\start-gpu.ps1` for an NVIDIA GPU). It serves on port 8880 just like Docker.

## Option B: KoboldCPP's built-in TTS (no extra server)
1. Download a TTS model from https://huggingface.co/koboldcpp/tts. `Kokoro_no_espeak_Q4.gguf` is a good pick (CPU only, about 2× realtime).
2. KoboldCPP launcher → **Audio** tab → *TTS Model* → pick the file, then Launch.
   Command line: `koboldcpp --model your-model.gguf --ttsmodel Kokoro_no_espeak_Q4.gguf`
   (OuteTTS / Qwen3TTS models also need `--ttswavtokenizer <tokenizer.gguf>`.)
3. In the app: Backend **KoboldCPP TTS**, URL = your KoboldCPP URL (default `http://localhost:5001`).
   Kokoro voices: `af_heart`, `af_bella`, `af_sky`, `af_nova`, `am_adam`, `am_michael`, `bf_emma`, `bm_george`, …; press ↻ to list what your build offers (`GET /v1/audio/voices`).
   Note: TTS shares the machine with text generation, so it can slow replies a little.

## Behaviour
- **Speaker button** 🔊 on each reply plays it; ⏹ stops it.
- **Auto-play** starts speaking sentence by sentence while the reply is still streaming. Sending, regenerating, editing, deleting or pressing Stop cuts it off.
- **Thinking is never read aloud** by default: `<think>`, `<thinking>` and `<reasoning>` blocks are removed (including an unfinished block while streaming, and reasoning that ends with only a closing tag). Turn on *Speak thinking* to hear them.
- *Skip \*actions\** leaves out roleplay actions written in asterisks.
- **Per-character voice:** set *TTS voice override* in the character editor. It's included when you export the character.
- **Phones:** browsers only allow sound after a tap. The first Send (or a speaker button) unlocks audio.

## Troubleshooting
- "Could not reach TTS server": the server isn't running, or the URL/port is wrong (check from the PC: http://localhost:8880/docs).
- No sound on iPhone: turn off silent mode, then tap a 🔊 button once.
- Choppy start: the first sentence has to be synthesized before playback starts. Kokoro on GPU is fastest.
