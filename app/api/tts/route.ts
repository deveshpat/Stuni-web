import { NextRequest, NextResponse } from "next/server";

const DEFAULT_TTS_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TTS_MODEL = "openai/gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "alloy";

export async function POST(request: NextRequest) {
  const apiKey = process.env.TTS_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Server is missing TTS_API_KEY (or OPENROUTER_API_KEY fallback) for remote audio generation.",
      },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    text?: string;
  } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "Text is required." }, { status: 400 });
  }

  const baseUrl = (process.env.TTS_API_BASE_URL || DEFAULT_TTS_BASE_URL).replace(
    /\/$/,
    "",
  );
  const model = process.env.TTS_MODEL || DEFAULT_TTS_MODEL;
  const voice = process.env.TTS_VOICE || DEFAULT_TTS_VOICE;

  let ttsResponse: Response;
  try {
    ttsResponse = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: "mp3",
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Remote TTS request failed due to a network error." },
      { status: 502 },
    );
  }

  if (!ttsResponse.ok) {
    const failureBody = await ttsResponse.text();
    return NextResponse.json(
      {
        error: `Remote TTS request failed (${ttsResponse.status}). ${failureBody}`,
      },
      { status: 502 },
    );
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  return new NextResponse(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
