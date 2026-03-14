# stuni-web (V1)

stuni-web is an AI explainer video generator built with Next.js.
Script generation now uses OpenRouter on the server, while rendering and TTS remain local in the browser.

## V1 pipeline

1. **OpenRouter API (server-side route)**
   - Calls `https://openrouter.ai/api/v1/chat/completions`
   - Uses `OPENROUTER_API_KEY` from server environment variables only
   - Generates a strict JSON slide script:
   - `[{"spoken_text":"...","slide_heading":"...","slide_bullet":"..."}]`
2. **Canvas rendering**
   - Draws each slide to a hidden `1920x1080` canvas
   - Exports `slide_X.png` blobs
3. **Transformers.js TTS (`@xenova/transformers`)**
   - Uses `Xenova/speecht5_tts` to generate narration per slide
   - Exports `audio_X.wav` blobs and calculates exact durations
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

Create a local environment file at `/home/runner/work/Stuni-web/Stuni-web/.env.local`:

```bash
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
# Optional:
# OPENROUTER_MODEL=openai/gpt-4o-mini
# OPENROUTER_APP_TITLE=stuni-web
```

Open http://localhost:3000

## Keeping the API key private on GitHub

- Never commit real keys to the repository.
- Keep local keys only in `.env.local` (already ignored by `.gitignore`).
- For GitHub Actions, store the key in **Repository Settings → Secrets and variables → Actions → New repository secret** (name it `OPENROUTER_API_KEY`).
- For deployments (for example Vercel), add `OPENROUTER_API_KEY` in deployment environment variables, not in code.
- If a key is ever pasted in chat/commits/issues, rotate/revoke it immediately in OpenRouter.

## Notes

- This is still a browser-heavy demo because rendering and TTS run on user hardware (WebAssembly/WebAudio).
- First run can take significant time because TTS/wasm assets must load.
