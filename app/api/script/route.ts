import { NextRequest, NextResponse } from "next/server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openrouter/free";
const DEFAULT_FALLBACK_MODEL = "meta-llama/llama-3.2-3b-instruct:free";
const DEFAULT_FALLBACK_MODELS = [
  "openai/gpt-oss-20b:free",
  "google/gemma-3-4b-it:free",
  "qwen/qwen3-4b:free",
];

type OpenRouterMessageContent =
  | string
  | Array<{ type?: string; text?: string }>
  | null
  | undefined;

type OpenRouterChoice = {
  message?: { content?: OpenRouterMessageContent };
  text?: string | null;
};

function extractContent(choices: OpenRouterChoice[] | undefined): string {
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  for (const choice of choices) {
    const raw = choice?.message?.content;
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }

    if (Array.isArray(raw)) {
      const text = raw
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }

    if (typeof choice?.text === "string" && choice.text.trim()) {
      return choice.text.trim();
    }
  }

  return "";
}

async function requestOpenRouter(
  apiKey: string,
  origin: string,
  appTitle: string,
  model: string,
  prompt: string,
): Promise<Response> {
  return fetch(OPENROUTER_URL, {
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
}

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

  const fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;

  const envFallbackModels = (process.env.OPENROUTER_FALLBACK_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const modelAttempts = [
    model,
    fallbackModel,
    ...envFallbackModels,
    ...DEFAULT_FALLBACK_MODELS,
  ].filter((item, idx, arr) => Boolean(item) && arr.indexOf(item) === idx);

  let content = "";
  const attemptErrors: string[] = [];

  for (const attemptModel of modelAttempts) {
    try {
      const response = await requestOpenRouter(
        apiKey,
        origin,
        appTitle,
        attemptModel,
        prompt,
      );

      if (!response.ok) {
        const failureBody = (await response.text()).slice(0, 220);
        attemptErrors.push(`${attemptModel}: HTTP ${response.status} ${failureBody}`);
        continue;
      }

      const data = (await response.json()) as {
        choices?: OpenRouterChoice[];
      };
      content = extractContent(data.choices);

      if (content) {
        break;
      }

      attemptErrors.push(`${attemptModel}: empty content in successful response`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      attemptErrors.push(`${attemptModel}: ${message}`);
    }
  }

  if (!content) {
    return NextResponse.json(
      {
        error:
          `OpenRouter did not return script content after ${modelAttempts.length} free-model attempts. ` +
          `Tried: ${modelAttempts.join(", ")}. Last results: ${attemptErrors.slice(-3).join(" | ")}`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ content });
}
