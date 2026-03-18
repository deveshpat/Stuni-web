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

  const model = (process.env.TTS_MODEL || "Xenova/mms-tts-eng").trim();

  try {
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
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `TTS failed: ${message}` }, { status: 500 });
  }
}
