import { runTool, TOOL_REGISTRY } from "@/lib/tools/registry";

type ChatMessage = { role: string; content: string };

type PendingHandler = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onToken?: (t: string) => void;
  onProgress?: (p: Record<string, unknown>) => void;
};

type GenerateOptions = {
  messages: ChatMessage[];
  tools?: unknown[];
  max_new_tokens?: number;
  onToken?: (token: string) => void;
  onProgress?: (progress: Record<string, unknown>) => void;
};

const CALL_TIMEOUT_MS = 180_000;

class GemmaManager {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingHandler>();
  private loadPromise: Promise<void> | null = null;

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/gemma.worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, payload } = e.data as {
          type: string;
          id: string;
          payload: unknown;
        };
        const handler = this.pending.get(id);
        if (!handler) return;

        if (type === "token") handler.onToken?.(String(payload ?? ""));
        if (type === "progress" && payload && typeof payload === "object") {
          handler.onProgress?.(payload as Record<string, unknown>);
        }
        if (type === "loaded" || type === "result") {
          this.pending.delete(id);
          handler.resolve(payload);
        }
        if (type === "error") {
          this.pending.delete(id);
          handler.reject(new Error(String(payload)));
        }
        if (type === "done") {
          this.pending.delete(id);
          handler.resolve(null);
        }
      };
    }

    return this.worker;
  }

  private call(
    type: string,
    payload: unknown,
    onToken?: (t: string) => void,
    onProgress?: (p: Record<string, unknown>) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gemma call timed out (${type})`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        onToken,
        onProgress,
      });

      this.getWorker().postMessage({ type, id, payload });
    });
  }

  async load(onProgress?: (p: Record<string, unknown>) => void): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.call("load", null, undefined, onProgress) as Promise<void>;
    return this.loadPromise;
  }

  async generate(options: GenerateOptions): Promise<unknown> {
    return this.call("generate", options, options.onToken, options.onProgress);
  }
}

export const gemma = new GemmaManager();

export async function agentLoop(
  userMessage: string,
  options: {
    onToken: (t: string) => void;
    onToolCall: (name: string, args: unknown) => void;
    onToolResult: (name: string, result: unknown) => void;
    memoryContext: string;
    history: ChatMessage[];
  },
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: options.memoryContext || "You are stuni, a browser-local agent." },
    ...options.history,
    { role: "user", content: userMessage },
  ];

  const maxIterations = 5;
  let finalText = "";

  for (let i = 0; i < maxIterations; i += 1) {
    let chunk = "";

    await gemma.generate({
      messages,
      tools: TOOL_REGISTRY,
      max_new_tokens: 800,
      onToken: (token) => {
        chunk += token;
        options.onToken(token);
      },
    });

    const trimmed = chunk.trim();
    if (!trimmed) {
      break;
    }

    finalText = trimmed;

    const toolCall = extractToolCall(trimmed);
    if (!toolCall) {
      break;
    }

    options.onToolCall(toolCall.name, toolCall.args);

    try {
      const result = await runTool(toolCall.name, toolCall.args);
      options.onToolResult(toolCall.name, result);
      messages.push({ role: "assistant", content: trimmed });
      messages.push({
        role: "user",
        content: `Tool result for ${toolCall.name}: ${safeStringify(result)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onToolResult(toolCall.name, { error: message });
      messages.push({ role: "assistant", content: trimmed });
      messages.push({
        role: "user",
        content: `Tool error for ${toolCall.name}: ${message}`,
      });
    }
  }

  return finalText.trim();
}

function extractToolCall(
  text: string,
): {
  name: string;
  args: Record<string, unknown>;
} | null {
  const jsonCandidate = findJsonObject(text);
  if (!jsonCandidate) return null;

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      tool?: string;
      name?: string;
      args?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
    };
    const name = parsed.tool || parsed.name;
    if (!name) return null;
    const args = parsed.args || parsed.arguments || {};
    return { name, args };
  } catch {
    return null;
  }
}

function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
