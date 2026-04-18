import { NextRequest, NextResponse } from "next/server";

// Pipeline instance is cached at module level so the model is loaded once
// per server process — subsequent requests are fast without any new download.
let pipelineInstance: unknown = null;
let loadedModel = "";

function float32ToWav(audioData: Float32Array, sampleRate: number): Buffer {
  const bitsPerSample = 16;
  const dataSize = audioData.length * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);       // PCM chunk size
  buf.writeUInt16LE(1, 20);        // PCM format
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < audioData.length; i++) {
    const s = Math.max(-1, Math.min(1, audioData[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/**
 * Call an OpenAI-compatible TTS endpoint (e.g. OpenRouter, OpenAI, or any
 * compatible proxy).  Used when TTS_API_BASE_URL is set in the environment.
 */
async function generateWithRemoteAPI(text: string): Promise<NextResponse> {
  const apiBase = (process.env.TTS_API_BASE_URL || "").replace(/\/$/, "");
  // TTS_API_KEY takes precedence; falls back to OPENROUTER_API_KEY so that a
  // single key works for both script generation and remote TTS on OpenRouter.
  const apiKey = (process.env.TTS_API_KEY || process.env.OPENROUTER_API_KEY || "").trim();
  const model = (process.env.TTS_MODEL || "openrouter/auto").trim();
  const voice = (process.env.TTS_VOICE || "alloy").trim();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${apiBase}/audio/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: text, voice, response_format: "wav" }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const truncated = errText.length > 200 ? `${errText.slice(0, 200)}…` : errText;
    throw new Error(`Remote TTS API: HTTP ${response.status} ${truncated}`);
  }

  const contentType = response.headers.get("content-type") || "audio/wav";
  const audioBuffer = await response.arrayBuffer();
  return new NextResponse(audioBuffer, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}

/**
 * Generate TTS locally using @xenova/transformers (Xenova/mms-tts-eng by default).
 * Used when TTS_API_BASE_URL is not set.
 */
async function generateWithXenova(text: string): Promise<NextResponse> {
  const model = (process.env.TTS_MODEL || "Xenova/mms-tts-eng").trim();

  // Re-initialise if the model env var changed between requests.
  if (!pipelineInstance || loadedModel !== model) {
    const { pipeline } = await import("@xenova/transformers");
    pipelineInstance = await pipeline("text-to-speech", model);
    loadedModel = model;
  }

  const output = await (
    pipelineInstance as (
      text: string,
    ) => Promise<{ audio: Float32Array; sampling_rate: number }>
  )(text);

  const wav = float32ToWav(output.audio, output.sampling_rate);

  return new NextResponse(wav.buffer as ArrayBuffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  let body: { text?: string } | null = null;
  try {
    body = (await request.json()) as { text?: string };
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "Text is required." }, { status: 400 });
  }

  try {
    const apiBase = process.env.TTS_API_BASE_URL?.trim();
    if (apiBase) {
      return await generateWithRemoteAPI(text);
    }
    return await generateWithXenova(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `TTS failed: ${message}` }, { status: 500 });
  }
}
