# stuni-web (V1)

stuni-web is a local-first, in-browser AI explainer video generator built with Next.js.
No backend is required for the V1 prototype pipeline.

## V1 pipeline

1. **WebLLM (`@mlc-ai/web-llm`)**
   - Loads `Llama-3.2-1B-Instruct-q4f16_1-MLC` by default
   - Falls back to `SmolLM2-360M-Instruct-q4f16_1-MLC` when browser memory is constrained
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

Open http://localhost:3000

## Notes

- This is a browser-heavy demo and depends on user device capabilities (WebGPU/WebAssembly).
- First run can take significant time because models and wasm assets must load.
