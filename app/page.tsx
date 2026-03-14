"use client";

import { useRef, useState } from "react";

type Slide = {
  spoken_text: string;
  slide_heading: string;
  slide_bullet: string;
};

type GeneratedAudio = {
  blob: Blob;
  durationSec: number;
};

const DEFAULT_PROMPT =
  "Accelerators in India";
const SPEECH_MODEL = "Xenova/speecht5_tts";
const SPEAKER_EMBEDDINGS_URL =
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin";

function parseSlidesFromLLM(raw: string): Slide[] {
  const startIndex = raw.indexOf("[");
  const endIndex = raw.lastIndexOf("]");
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error("LLM output did not contain a JSON array.");
  }

  const parsed = JSON.parse(raw.slice(startIndex, endIndex + 1));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Parsed script is empty.");
  }

  return parsed.map((item, idx) => {
    if (
      typeof item?.spoken_text !== "string" ||
      typeof item?.slide_heading !== "string" ||
      typeof item?.slide_bullet !== "string"
    ) {
      throw new Error(`Slide ${idx + 1} does not match required schema.`);
    }
    return {
      spoken_text: item.spoken_text.trim(),
      slide_heading: item.slide_heading.trim(),
      slide_bullet: item.slide_bullet.trim(),
    };
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/);
  let line = "";
  let currentY = y;

  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = word;
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  });

  if (line) {
    ctx.fillText(line, x, currentY);
  }
}

function drawSlideToBlob(slide: Slide): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context is unavailable.");
  }

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(1, "#111827");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#1f2937";
  ctx.fillRect(120, 120, 1680, 840);

  ctx.textAlign = "center";
  ctx.fillStyle = "#f9fafb";
  ctx.font = "bold 88px Arial";
  wrapText(ctx, slide.slide_heading, canvas.width / 2, 320, 1450, 98);

  ctx.font = "48px Arial";
  ctx.fillStyle = "#d1d5db";
  wrapText(
    ctx,
    `• ${slide.slide_bullet}`,
    canvas.width / 2,
    640,
    1500,
    62,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to export slide as PNG."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function float32ToWav(floatData: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + floatData.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + floatData.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, floatData.length * 2, true);

  let offset = 44;
  for (let i = 0; i < floatData.length; i += 1) {
    const value = Math.max(-1, Math.min(1, floatData[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

async function getAudioDuration(blob: Blob): Promise<number> {
  const context = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return audioBuffer.duration;
  } finally {
    await context.close();
  }
}

export default function Home() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const ttsRef = useRef<unknown>(null);
  const ffmpegRef = useRef<unknown>(null);
  const speakerEmbeddingsRef = useRef<Float32Array | null>(null);

  const appendLog = (line: string) => {
    console.log(`[stuni-web] ${line}`);
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`]);
  };

  const generateVideo = async () => {
    if (!prompt.trim() || isGenerating) {
      return;
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }

    setSlideCount(0);
    setLogs([]);
    setIsGenerating(true);
    setStatus("Loading AI");
    appendLog("Starting generation pipeline.");

    try {
      appendLog("Step 1/4: Requesting script from OpenRouter.");
      setStatus("Writing Script");
      const llmPrompt = `You are an educational scriptwriter for short explainer videos.
Return valid raw JSON only. Do not use markdown, code fences, or extra text.
Generate 4 slides in this exact format:
[{"spoken_text":"...","slide_heading":"...","slide_bullet":"..."}]

Topic: ${prompt}`;

      const scriptResponse = await fetch("/api/script", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: llmPrompt }),
      });
      if (!scriptResponse.ok) {
        const responseBody = (await scriptResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(responseBody.error ?? "Failed to generate script.");
      }
      const scriptBody = (await scriptResponse.json()) as {
        content?: string;
      };

      const rawScript = scriptBody.content ?? "";
      appendLog(`LLM raw output received (${rawScript.length} chars).`);
      const slides = parseSlidesFromLLM(rawScript);
      setSlideCount(slides.length);
      appendLog(`Parsed ${slides.length} slides from script JSON.`);

      setStatus("Generating Visuals");
      appendLog("Step 2/4: Drawing slides on hidden canvas.");
      const slideImages: Blob[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const imageBlob = await drawSlideToBlob(slides[i]);
        slideImages.push(imageBlob);
        appendLog(`Rendered slide_${i + 1}.png`);
      }

      setStatus("Generating Audio");
      appendLog("Step 3/4: Initializing local TTS.");
      if (!ttsRef.current) {
        const { pipeline } = await import("@xenova/transformers");
        ttsRef.current = await pipeline("text-to-speech", SPEECH_MODEL, {
          progress_callback: (info: { status?: string; file?: string }) => {
            appendLog(
              `TTS: ${info.status ?? "loading"}${info.file ? ` (${info.file})` : ""}`,
            );
          },
        });
      } else {
        appendLog("TTS pipeline already initialized. Reusing loaded model.");
      }

      if (!speakerEmbeddingsRef.current) {
        appendLog("Downloading speaker embeddings for SpeechT5.");
        const speakerBuffer = await fetch(SPEAKER_EMBEDDINGS_URL).then((res) =>
          res.arrayBuffer(),
        );
        speakerEmbeddingsRef.current = new Float32Array(speakerBuffer);
      }

      const audioFiles: GeneratedAudio[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const output = await (
          ttsRef.current as (
            text: string,
            options: { speaker_embeddings: Float32Array },
          ) => Promise<{ audio: Float32Array; sampling_rate: number }>
        )(slides[i].spoken_text, {
          speaker_embeddings: speakerEmbeddingsRef.current,
        });

        const wavData = float32ToWav(output.audio, output.sampling_rate);
        const wavBytes = new Uint8Array(wavData.byteLength);
        wavBytes.set(wavData);
        const wavBlob = new Blob([wavBytes.buffer], { type: "audio/wav" });
        const durationSec = await getAudioDuration(wavBlob);
        audioFiles.push({ blob: wavBlob, durationSec });
        appendLog(`Generated audio_${i + 1}.wav (${durationSec.toFixed(2)}s)`);
      }

      setStatus("Rendering Video");
      appendLog("Step 4/4: Loading FFmpeg.wasm.");
      if (!ffmpegRef.current) {
        const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
          import("@ffmpeg/ffmpeg"),
          import("@ffmpeg/util"),
        ]);
        const ffmpeg = new FFmpeg();
        ffmpeg.on("log", ({ message }) => appendLog(`ffmpeg: ${message}`));
        await ffmpeg.load({
          coreURL: await toBlobURL(
            "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
            "text/javascript",
          ),
          wasmURL: await toBlobURL(
            "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
            "application/wasm",
          ),
        });
        ffmpegRef.current = { ffmpeg, fetchFile };
      } else {
        appendLog("FFmpeg already initialized. Reusing runtime.");
      }

      const { ffmpeg, fetchFile } = ffmpegRef.current as {
        ffmpeg: {
          writeFile: (name: string, data: Uint8Array) => Promise<void>;
          exec: (args: string[]) => Promise<number>;
          readFile: (name: string) => Promise<Uint8Array>;
        };
        fetchFile: (file: Blob) => Promise<Uint8Array>;
      };

      const segmentNames: string[] = [];
      for (let i = 0; i < slides.length; i += 1) {
        const slideName = `slide_${i + 1}.png`;
        const audioName = `audio_${i + 1}.wav`;
        const segmentName = `segment_${i + 1}.mp4`;
        segmentNames.push(segmentName);

        await ffmpeg.writeFile(slideName, await fetchFile(slideImages[i]));
        await ffmpeg.writeFile(audioName, await fetchFile(audioFiles[i].blob));
        await ffmpeg.exec([
          "-loop",
          "1",
          "-i",
          slideName,
          "-i",
          audioName,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-tune",
          "stillimage",
          "-c:a",
          "aac",
          "-shortest",
          "-t",
          audioFiles[i].durationSec.toFixed(3),
          segmentName,
        ]);

        appendLog(`Rendered ${segmentName}`);
      }

      const concatFile = segmentNames.map((name) => `file '${name}'`).join("\n");
      await ffmpeg.writeFile("segments.txt", new TextEncoder().encode(concatFile));
      await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "segments.txt",
        "-c",
        "copy",
        "stuni_explainer.mp4",
      ]);

      const output = await ffmpeg.readFile("stuni_explainer.mp4");
      const videoBytes = new Uint8Array(output.byteLength);
      videoBytes.set(output);
      const outputUrl = URL.createObjectURL(
        new Blob([videoBytes.buffer], { type: "video/mp4" }),
      );
      setVideoUrl(outputUrl);
      setStatus("Done");
      appendLog("Pipeline complete. Video is ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      setStatus("Failed");
      appendLog(`Pipeline failed: ${message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#020617] text-slate-100 p-6 md:p-10">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
          <h1 className="text-2xl font-bold">stuni-web V1</h1>
          <p className="text-slate-300 text-sm">
            OpenRouter script generation + local TTS + FFmpeg.wasm video rendering.
          </p>

          <label htmlFor="prompt" className="text-sm text-slate-300 block">
            Topic / Prompt
          </label>
          <textarea
            id="prompt"
            className="w-full h-56 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-indigo-500"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should this explainer video teach?"
          />

          <button
            type="button"
            onClick={generateVideo}
            disabled={isGenerating}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:cursor-not-allowed px-4 py-3 font-semibold transition-colors"
          >
            {isGenerating ? "Generating..." : "Generate Video"}
          </button>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Canvas & Terminal</h2>
            <span className="rounded-md px-3 py-1 text-xs font-medium bg-slate-800 text-slate-200">
              Status: {status}
            </span>
          </div>

          <div className="rounded-lg bg-black/40 border border-slate-800 p-3 h-56 overflow-y-auto font-mono text-xs space-y-1">
            {logs.length === 0 ? (
              <p className="text-slate-400">Logs will appear here during generation.</p>
            ) : (
              logs.map((line, idx) => (
                <p key={idx} className="text-emerald-300">
                  {line}
                </p>
              ))
            )}
          </div>

          {slideCount > 0 && (
            <p className="text-sm text-slate-300">Script slides: {slideCount}</p>
          )}

          {videoUrl ? (
            <div className="space-y-3">
              <video controls className="w-full rounded-lg border border-slate-700">
                <source src={videoUrl} type="video/mp4" />
              </video>
              <a
                href={videoUrl}
                download="stuni_explainer.mp4"
                className="inline-flex rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-semibold transition-colors"
              >
                Download
              </a>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400 text-sm">
              Generated video will appear here.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
