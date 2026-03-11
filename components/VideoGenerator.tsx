"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Slide {
  spoken_text: string;
  slide_heading: string;
  slide_bullet: string;
}

type Stage =
  | "idle"
  | "loading_llm"
  | "generating_script"
  | "rendering_slides"
  | "loading_tts"
  | "generating_audio"
  | "loading_ffmpeg"
  | "stitching_video"
  | "done"
  | "error";

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  type: "info" | "success" | "error" | "warning" | "progress";
}

interface AudioResult {
  wavBytes: Uint8Array;
  duration: number;
}

// ─── Ordered stage list (used to check if a step is complete) ─────────────────

const STAGE_ORDER: Stage[] = [
  "idle",
  "loading_llm",
  "generating_script",
  "rendering_slides",
  "loading_tts",
  "generating_audio",
  "loading_ffmpeg",
  "stitching_video",
  "done",
];

function stageIndex(s: Stage): number {
  return STAGE_ORDER.indexOf(s);
}

// ─── WAV encoder (Float32 PCM → 16-bit PCM WAV) ───────────────────────────────

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeStr(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

// ─── Canvas text-wrap helper ──────────────────────────────────────────────────

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): number {
  const words = text.split(" ");
  let line = "";
  let currentY = y;

  for (const word of words) {
    const testLine = line + word + " ";
    if (ctx.measureText(testLine).width > maxWidth && line !== "") {
      ctx.fillText(line.trim(), x, currentY);
      line = word + " ";
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line.trim()) {
    ctx.fillText(line.trim(), x, currentY);
    currentY += lineHeight;
  }
  return currentY;
}

// ─── Slide renderer (Canvas → PNG Blob) ──────────────────────────────────────

function renderSlide(slide: Slide, index: number, total: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const W = 1280;
    const H = 720;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return reject(new Error("Cannot get 2D canvas context"));

    // Dark gradient background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0d0d1a");
    bg.addColorStop(1, "#1a0d2e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Top accent bar
    const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
    accentGrad.addColorStop(0, "#6366f1");
    accentGrad.addColorStop(1, "#a855f7");
    ctx.fillStyle = accentGrad;
    ctx.fillRect(0, 0, W, 6);

    // Slide counter
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = '400 20px "Arial", sans-serif';
    ctx.textAlign = "right";
    ctx.fillText(`${index + 1} / ${total}`, W - 60, 52);

    // Heading
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 62px "Arial", sans-serif';
    ctx.textAlign = "center";
    const headingEndY = wrapText(
      ctx,
      slide.slide_heading,
      W / 2,
      270,
      W - 140,
      78
    );

    // Separator line
    const lineGrad = ctx.createLinearGradient(W / 2 - 180, 0, W / 2 + 180, 0);
    lineGrad.addColorStop(0, "transparent");
    lineGrad.addColorStop(0.5, "#6366f1");
    lineGrad.addColorStop(1, "transparent");
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 180, headingEndY + 8);
    ctx.lineTo(W / 2 + 180, headingEndY + 8);
    ctx.stroke();

    // Bullet text
    ctx.fillStyle = "#a5b4fc";
    ctx.font = '400 34px "Arial", sans-serif';
    ctx.textAlign = "center";
    wrapText(ctx, slide.slide_bullet, W / 2, headingEndY + 50, W - 180, 48);

    // Brand watermark
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.font = '400 18px "Arial", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("stuni", W / 2, H - 28);

    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VideoGenerator() {
  const [topic, setTopic] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const logIdRef = useRef(0);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom when new logs arrive
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      console.log(`[stuni][${type}] ${message}`);
      setLogs((prev) => [
        ...prev,
        {
          id: logIdRef.current++,
          timestamp: new Date().toLocaleTimeString(),
          message,
          type,
        },
      ]);
    },
    []
  );

  const generate = useCallback(async () => {
    if (!topic.trim()) return;

    setLogs([]);
    setVideoUrl(null);
    setStage("loading_llm");

    try {
      // ── Step 1: WebLLM – Generate script ──────────────────────────────────
      addLog("🧠 Loading WebLLM engine…");
      addLog(
        "   Model: Phi-3-mini-4k-instruct-q4f16_1-MLC (~2.5 GB on first run)",
        "warning"
      );
      addLog("   Requires a WebGPU-enabled browser (Chrome 113+)", "warning");

      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");

      const engine = await CreateMLCEngine(
        "Phi-3-mini-4k-instruct-q4f16_1-MLC",
        {
          initProgressCallback: (report: { text: string; progress: number }) => {
            addLog(`   ${report.text}`, "progress");
          },
        }
      );

      addLog("✅ LLM engine ready!", "success");
      setStage("generating_script");
      addLog(`✍️  Generating 3-slide script for: "${topic}"`);

      const systemPrompt = `You are an expert educational scriptwriter. Given a topic, create a concise 3-slide explainer video script.
You MUST respond with ONLY a valid JSON array — no markdown, no code blocks, no extra text.

Required structure (exactly 3 objects):
[
  {
    "spoken_text": "The narrator text for this slide (1-2 sentences).",
    "slide_heading": "Short heading (3-6 words)",
    "slide_bullet": "One key bullet point (concise phrase)"
  }
]`;

      const completion = await engine.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Create an explainer video script about: ${topic}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      });

      const rawOutput = completion.choices[0].message.content ?? "";
      addLog("📄 LLM output received, parsing JSON…");
      console.log("[stuni] LLM raw output:", rawOutput);

      // Extract JSON: try direct parse, then regex extraction
      let slides: Slide[];
      try {
        slides = JSON.parse(rawOutput);
      } catch {
        const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          throw new Error(
            "LLM response did not contain a JSON array. Please try again."
          );
        }
        slides = JSON.parse(jsonMatch[0]);
      }

      if (!Array.isArray(slides) || slides.length === 0) {
        throw new Error("LLM returned an empty or invalid slides array.");
      }

      addLog(`✅ Script ready: ${slides.length} slides`, "success");
      slides.forEach((s, i) =>
        addLog(`   Slide ${i + 1}: "${s.slide_heading}"`)
      );

      // ── Step 2: Canvas – Render slide images ───────────────────────────────
      setStage("rendering_slides");
      addLog("🖼️  Rendering slide images on canvas (1280 × 720)…");

      const slideBlobs: Blob[] = [];
      for (let i = 0; i < slides.length; i++) {
        addLog(`   Rendering slide ${i + 1}/${slides.length}…`);
        const blob = await renderSlide(slides[i], i, slides.length);
        slideBlobs.push(blob);
        addLog(
          `   ✅ slide_${i + 1}.png (${(blob.size / 1024).toFixed(1)} KB)`,
          "success"
        );
      }

      // ── Step 3: Transformers.js – TTS audio ────────────────────────────────
      setStage("loading_tts");
      addLog("🎙️  Loading TTS model (Xenova/speecht5_tts)…");
      addLog("   Models are cached after the first download.", "warning");

      const { pipeline: createPipeline, env } = await import(
        "@xenova/transformers"
      );

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const synthesizer = await createPipeline(
        "text-to-speech",
        "Xenova/speecht5_tts",
        {
          quantized: false,
          progress_callback: (
            data: {
              status: string;
              name?: string;
              progress?: number;
            }
          ) => {
            if (data.status === "downloading" && data.name) {
              const pct =
                data.progress !== undefined
                  ? ` ${data.progress.toFixed(1)}%`
                  : "";
              addLog(`   Downloading ${data.name}${pct}`, "progress");
            } else if (data.status === "loaded" && data.name) {
              addLog(`   Loaded: ${data.name}`, "info");
            }
          },
        }
      );

      addLog("✅ TTS model ready!", "success");
      setStage("generating_audio");
      addLog("🎵 Synthesizing audio for each slide…");

      const SPEAKER_EMBEDDINGS_URL =
        "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin";

      const audioResults: AudioResult[] = [];
      for (let i = 0; i < slides.length; i++) {
        addLog(
          `   Synthesizing audio ${i + 1}/${slides.length}: "${slides[i].spoken_text.slice(0, 60)}…"`
        );

        const result = (await synthesizer(slides[i].spoken_text, {
          speaker_embeddings: SPEAKER_EMBEDDINGS_URL,
        })) as { audio: Float32Array; sampling_rate: number };

        const { audio, sampling_rate } = result;
        const wavBytes = encodeWav(audio, sampling_rate);
        const duration = audio.length / sampling_rate;

        audioResults.push({ wavBytes, duration });
        addLog(
          `   ✅ audio_${i + 1}.wav  ${duration.toFixed(2)}s  ${sampling_rate} Hz`,
          "success"
        );
      }

      // ── Step 4: FFmpeg.wasm – Stitch video ────────────────────────────────
      setStage("loading_ffmpeg");
      addLog("🎬 Loading FFmpeg.wasm (single-threaded core)…");

      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");

      const ffmpeg = new FFmpeg();

      ffmpeg.on("log", ({ message }) => {
        console.log("[FFmpeg]", message);
      });

      let lastProgressPct = -1;
      ffmpeg.on("progress", ({ progress }) => {
        const pct = Math.min(100, Math.round(progress * 100));
        if (pct !== lastProgressPct) {
          lastProgressPct = pct;
          addLog(`   Encoding: ${pct}%`, "progress");
        }
      });

      const CORE_BASE =
        "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.js`,
          "text/javascript"
        ),
        wasmURL: await toBlobURL(
          `${CORE_BASE}/ffmpeg-core.wasm`,
          "application/wasm"
        ),
      });

      addLog("✅ FFmpeg.wasm loaded!", "success");
      setStage("stitching_video");

      // Write images and audio into FFmpeg's in-memory filesystem
      addLog("📁 Writing files to FFmpeg virtual filesystem…");
      for (let i = 0; i < slides.length; i++) {
        const slideBytes = new Uint8Array(await slideBlobs[i].arrayBuffer());
        await ffmpeg.writeFile(`slide_${i}.png`, slideBytes);
        await ffmpeg.writeFile(`audio_${i}.wav`, audioResults[i].wavBytes);
        addLog(`   Wrote slide_${i}.png + audio_${i}.wav`);
      }

      // Encode each slide+audio pair into its own MP4 segment
      addLog("🎞️  Encoding video segments…");
      for (let i = 0; i < slides.length; i++) {
        const dur = audioResults[i].duration.toFixed(3);
        addLog(
          `   Encoding segment ${i + 1}/${slides.length}  (${dur}s)…`
        );
        await ffmpeg.exec([
          "-loop", "1",
          "-t", dur,
          "-i", `slide_${i}.png`,
          "-i", `audio_${i}.wav`,
          "-vf", "scale=1280:720",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "128k",
          "-shortest",
          `segment_${i}.mp4`,
        ]);
        addLog(`   ✅ segment_${i}.mp4 done`, "success");
        lastProgressPct = -1; // reset for next segment
      }

      // Build concat list and merge
      addLog("🔗 Concatenating segments…");
      const concatList = slides.map((_, i) => `file 'segment_${i}.mp4'`).join("\n");
      await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concatList));

      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", "concat.txt",
        "-c", "copy",
        "stuni_explainer.mp4",
      ]);

      // Read final video and create a Blob URL
      addLog("📦 Reading final video from FFmpeg memory…");
      const outputData = await ffmpeg.readFile("stuni_explainer.mp4");
      // outputData is FileData (string | Uint8Array); copy bytes into a plain ArrayBuffer
      const outputBytes =
        outputData instanceof Uint8Array
          ? outputData
          : new TextEncoder().encode(outputData as string);
      const videoBlob = new Blob([outputBytes.buffer as ArrayBuffer], {
        type: "video/mp4",
      });
      const url = URL.createObjectURL(videoBlob);

      setVideoUrl(url);
      setStage("done");
      addLog(
        `✅ Video ready!  Size: ${(videoBlob.size / 1024).toFixed(1)} KB`,
        "success"
      );
      addLog("🎉 Your AI explainer video is ready to watch and download!", "success");
    } catch (err) {
      console.error("[stuni] Pipeline error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`❌ Error: ${msg}`, "error");
      setStage("error");
    }
  }, [topic, addLog]);

  // ── Derived UI state ──────────────────────────────────────────────────────
  const isGenerating = !["idle", "done", "error"].includes(stage);

  const stageLabel: Record<Stage, string> = {
    idle: "Ready",
    loading_llm: "Loading AI…",
    generating_script: "Writing Script…",
    rendering_slides: "Rendering Slides…",
    loading_tts: "Loading TTS…",
    generating_audio: "Generating Audio…",
    loading_ffmpeg: "Loading FFmpeg…",
    stitching_video: "Rendering Video…",
    done: "Done!",
    error: "Error",
  };

  const logColor: Record<LogEntry["type"], string> = {
    info: "text-gray-300",
    success: "text-green-400",
    error: "text-red-400",
    warning: "text-yellow-400",
    progress: "text-blue-400",
  };

  const pipelineSteps = [
    {
      label: "Generate Script",
      icon: "🧠",
      activeStages: ["loading_llm", "generating_script"] as Stage[],
      doneAfter: "generating_script" as Stage,
    },
    {
      label: "Render Slides",
      icon: "🖼️",
      activeStages: ["rendering_slides"] as Stage[],
      doneAfter: "rendering_slides" as Stage,
    },
    {
      label: "Synthesize Audio",
      icon: "🎙️",
      activeStages: ["loading_tts", "generating_audio"] as Stage[],
      doneAfter: "generating_audio" as Stage,
    },
    {
      label: "Stitch Video",
      icon: "🎬",
      activeStages: ["loading_ffmpeg", "stitching_video"] as Stage[],
      doneAfter: "stitching_video" as Stage,
    },
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* ── Header ── */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm select-none">
          S
        </div>
        <h1 className="text-lg font-semibold">
          Stuni{" "}
          <span className="text-gray-500 font-normal text-sm">
            — AI Explainer Video Generator
          </span>
        </h1>
        <div className="ml-auto text-xs text-gray-600 hidden sm:block">
          100% Local · No API Keys · Runs in Your Browser
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left Panel: Controls ── */}
        <aside className="w-72 shrink-0 border-r border-gray-800 p-5 flex flex-col gap-5 overflow-y-auto">
          {/* Prompt textarea */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">
              Topic / Prompt
            </label>
            <textarea
              className="w-full h-36 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
              placeholder={
                "e.g. How does photosynthesis work?\n\nOr: Explain quantum entanglement for beginners."
              }
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              disabled={isGenerating}
            />
          </div>

          {/* Generate button */}
          <button
            onClick={generate}
            disabled={isGenerating || !topic.trim()}
            className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isGenerating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                {stageLabel[stage]}
              </span>
            ) : (
              "▶ Generate Video"
            )}
          </button>

          {/* Pipeline step indicators */}
          <div className="border-t border-gray-800 pt-4">
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider font-medium">
              Pipeline
            </p>
            {pipelineSteps.map(({ label, icon, activeStages, doneAfter }) => {
              const isActive = activeStages.includes(stage);
              const isDone =
                stage !== "error" &&
                stageIndex(stage) > stageIndex(doneAfter);
              return (
                <div
                  key={label}
                  className={`flex items-center gap-3 py-2 px-3 rounded-md mb-1 text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-950/60 text-indigo-300"
                      : isDone
                      ? "text-green-400"
                      : "text-gray-600"
                  }`}
                >
                  <span>{icon}</span>
                  <span className="flex-1">{label}</span>
                  {isDone && <span className="text-green-400 text-xs">✓</span>}
                  {isActive && (
                    <span className="text-indigo-400 animate-pulse text-xs">
                      ●
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Requirements note */}
          <div className="mt-auto border-t border-gray-800 pt-4 text-xs text-gray-600 space-y-1">
            <p className="text-gray-500 font-medium mb-1">Requirements</p>
            <p>• WebGPU browser (Chrome 113+)</p>
            <p>• ≥ 4 GB RAM</p>
            <p>• Internet for first model download</p>
          </div>
        </aside>

        {/* ── Right Panel: Terminal + Video ── */}
        <main className="flex-1 flex flex-col p-5 gap-4 min-w-0 overflow-hidden">
          {/* Terminal */}
          <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-1.5 shrink-0">
              <span className="w-3 h-3 rounded-full bg-red-500/60" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/60" />
              <span className="w-3 h-3 rounded-full bg-green-500/60" />
              <span className="ml-2 text-xs text-gray-500 font-mono">
                stuni · engine terminal
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-gray-600">
                  Enter a topic and press{" "}
                  <span className="text-indigo-400">▶ Generate Video</span> to
                  start…
                </p>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className={`${logColor[log.type]} leading-relaxed`}
                  >
                    <span className="text-gray-700">[{log.timestamp}]</span>{" "}
                    {log.message}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* Video player (shown when done) */}
          {videoUrl && (
            <div className="rounded-xl border border-gray-800 bg-black overflow-hidden shrink-0">
              <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
                <span className="text-sm font-medium text-green-400">
                  ✅ Video Ready
                </span>
                <a
                  href={videoUrl}
                  download="stuni_explainer.mp4"
                  className="text-xs px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                >
                  ⬇ Download MP4
                </a>
              </div>
              <video
                src={videoUrl}
                controls
                autoPlay
                className="w-full max-h-72"
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
