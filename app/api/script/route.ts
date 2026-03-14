import { NextRequest, NextResponse } from "next/server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Server is missing OPENROUTER_API_KEY. Add it to .env.local for local dev or Secrets in your deployment settings.",
      },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    prompt?: string;
  } | null;
  const prompt = body?.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }

  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const origin = request.headers.get("origin") || "http://localhost:3000";
  const appTitle = process.env.OPENROUTER_APP_TITLE || "stuni-web";

  let openRouterResponse: Response;
  try {
    openRouterResponse = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": origin,
        "X-Title": appTitle,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "OpenRouter request failed due to a network error." },
      { status: 502 },
    );
  }

  if (!openRouterResponse.ok) {
    const failureBody = await openRouterResponse.text();
    return NextResponse.json(
      {
        error: `OpenRouter request failed (${openRouterResponse.status}). ${failureBody}`,
      },
      { status: 502 },
    );
  }

  const data = (await openRouterResponse.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    return NextResponse.json(
      { error: "OpenRouter did not return content for script generation." },
      { status: 502 },
    );
  }

  return NextResponse.json({ content });
}
