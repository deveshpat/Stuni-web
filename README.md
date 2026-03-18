# stuni-web (V1)

stuni-web is an AI explainer video generator built with Next.js.
Script generation uses OpenRouter on the server, and audio generation can use either a remote API (default, low-memory) or local browser TTS.

## V1 pipeline

1. **OpenRouter API (server-side route)**
   - Calls `https://openrouter.ai/api/v1/chat/completions`
   - Uses `OPENROUTER_API_KEY` from server environment variables only
   - Generates a strict JSON slide script:
   - `[{"spoken_text":"...","slide_heading":"...","slide_bullet":"..."}]`
2. **Canvas rendering**
   - Draws each slide to a hidden `1920x1080` canvas
   - Exports `slide_X.png` blobs
3. **Audio generation (remote-first with local fallback)**
   - Default: server-side OpenAI-compatible `/api/tts` route (configured for OpenRouter-compatible base URL)
   - Fallback/local mode: Transformers.js TTS in browser (`NEXT_PUBLIC_LOCAL_TTS_MODEL`, default `Xenova/mms-tts-eng`)
   - Exports narration blobs and calculates exact durations
4. **FFmpeg.wasm (`@ffmpeg/ffmpeg`, `@ffmpeg/util`)**
   - Loops each slide image to its narration duration
   - Produces segment videos and concatenates into `stuni_explainer.mp4`
   - Displays playable video with a download button

## UI structure

- **Left panel:** Topic/Prompt textarea + Generate button
- **Right panel:** Progress terminal logs + final video preview/download

## Getting started

```bash
npm install
npm run dev
```

Create/update environment file at `.env` (or `.env.local`) in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
OPENROUTER_MODEL=openrouter/free
OPENROUTER_APP_TITLE=stuni-web

# Audio mode: remote (recommended on low-memory machines/codespaces) or local
NEXT_PUBLIC_AUDIO_PROVIDER=remote

# OpenAI-compatible TTS configuration (can point to OpenRouter or another compatible API)
# If TTS_API_KEY is empty, OPENROUTER_API_KEY is used.
TTS_API_KEY=
TTS_API_BASE_URL=https://openrouter.ai/api/v1
TTS_MODEL=openrouter/auto
TTS_VOICE=alloy

# Optional: only enable browser-side fallback when you explicitly want it.
# Keeping this false avoids long freezes on weak devices when remote TTS fails.
NEXT_PUBLIC_ENABLE_LOCAL_TTS_FALLBACK=false

# Local fallback model
NEXT_PUBLIC_LOCAL_TTS_MODEL=Xenova/mms-tts-eng
```

By default, this app uses `openrouter/free` (Free Models Router).  
If you want a specific free model, set `OPENROUTER_MODEL` to a `:free` variant (for example `meta-llama/llama-3.2-3b-instruct:free`).
If you set a paid model ID instead, OpenRouter may bill that request according to your account settings.
See OpenRouter’s free model list: https://openrouter.ai/models?pricing=free

Open http://localhost:3000

## Keeping the API key private on GitHub

- Yes — this setup stays secure even if the repository is public, as long as `OPENROUTER_API_KEY` is stored only in server-side secrets and never committed to source control.
- Never commit real keys to the repository.
- Keep local keys only in `.env.local` (already ignored by `.gitignore`).
- For GitHub Actions, store the key in **Repository Settings → Secrets and variables → Actions → New repository secret** (name it `OPENROUTER_API_KEY`).
- For deployments (e.g., Vercel), add `OPENROUTER_API_KEY` in deployment environment variables, not in code.
- Never expose the key to the browser (do not use `NEXT_PUBLIC_OPENROUTER_API_KEY` or any client-bundled variable).
- If a key is ever pasted in chat/commits/issues, rotate/revoke it immediately in OpenRouter.

## Notes

- This is still a browser-heavy demo because rendering and TTS run on user hardware (WebAssembly/WebAudio).
- First run can take significant time because TTS/wasm assets must load.
