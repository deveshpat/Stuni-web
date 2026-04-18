type ChatMessage = { role: string; content: string };

type GenerateOptions = {
  messages: ChatMessage[];
  tools?: unknown[];
  max_new_tokens?: number;
  onToken?: (token: string) => void;
  onProgress?: (progress: Record<string, unknown>) => void;
};

const GEMMA4_MODEL_IDS = [
  "onnx-community/gemma-4-E2B-it-ONNX",
] as const;

type DeviceType = "webgpu" | "wasm";
type DType = "fp16" | "fp32" | "q4f16" | "q8";

type LoadAttempt = {
  modelId: string;
  device: DeviceType;
  dtype: DType;
  modelFileName?: string;
  subfolder?: string;
  useExternalDataFormat?: number;
};

type GeneratorFn = (
  input: unknown,
  options: Record<string, unknown>,
) => Promise<Array<{ generated_text: unknown[] }>>;

class GemmaManager {
  private generator: GeneratorFn | null = null;
  private loadPromise: Promise<void> | null = null;

  private async detectExternalChunkCount(
    modelId: string,
    subfolder: string,
    baseName: string,
    maxChunks: number = 24,
  ): Promise<number> {
    let count = 0;
    for (let i = 0; i < maxChunks; i += 1) {
      const suffix = i === 0 ? "" : `_${i}`;
      const fileName = `${baseName}.onnx_data${suffix}`;
      const prefix = subfolder ? `${subfolder}/` : "";
      const url = `https://huggingface.co/${modelId}/resolve/main/${prefix}${fileName}`;
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) {
        break;
      }
      count += 1;
    }
    return count;
  }

  private async fetchPatchedGemma4Config(modelId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`https://huggingface.co/${modelId}/resolve/main/config.json`);
    if (!response.ok) {
      throw new Error(`Failed to fetch Gemma 4 config for ${modelId}: ${response.status}`);
    }

    const config = (await response.json()) as Record<string, unknown>;
    config.model_type = "gemma3_text";
    delete config["transformers.js_config"];
    return config;
  }

  async load(onProgress?: (p: Record<string, unknown>) => void): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      if (typeof window === "undefined") {
        throw new Error("Gemma 4 must be loaded in the browser.");
      }

      const hasWebGpu = "gpu" in navigator;
      if (!hasWebGpu) {
        throw new Error(
          "WebGPU is unavailable in this browser context. Gemma 4 requires WebGPU in this app; WASM fallback is disabled because it causes out-of-memory failures.",
        );
      }
      const devices: DeviceType[] = ["webgpu"];

      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      if (env.backends?.onnx) {
        env.backends.onnx.logLevel = "error";
      }
      const createPipeline = pipeline as unknown as (
        task: string,
        model: string,
        options: Record<string, unknown>,
      ) => Promise<unknown>;

      const attempts: LoadAttempt[] = [];
      const nav = navigator as Navigator & { deviceMemory?: number };
      const deviceMemoryGiB = nav.deviceMemory;
      const canTryFp32Merged = typeof deviceMemoryGiB !== "number" || deviceMemoryGiB >= 12;

      for (const modelId of GEMMA4_MODEL_IDS) {
        const decoderChunks = await this.detectExternalChunkCount(modelId, "onnx", "decoder_model_merged");
        const isE2B = modelId.includes("E2B");
        const allowMergedForModel = isE2B || canTryFp32Merged;

        for (const device of devices) {
          attempts.push({ modelId, device, dtype: "fp16", modelFileName: "model", subfolder: "onnx" });
          attempts.push({ modelId, device, dtype: "fp32", modelFileName: "model", subfolder: "onnx" });
          attempts.push({ modelId, device, dtype: "q4f16", modelFileName: "model", subfolder: "onnx" });
          attempts.push({ modelId, device, dtype: "q8", modelFileName: "model", subfolder: "onnx" });

          if (allowMergedForModel) {
            attempts.push({
              modelId,
              device,
              dtype: "fp32",
              modelFileName: "decoder_model_merged",
              subfolder: "onnx",
              useExternalDataFormat: decoderChunks || undefined,
            });
            attempts.push({ modelId, device, dtype: "fp32", modelFileName: "decoder_model_merged", subfolder: "onnx" });
            attempts.push({ modelId, device, dtype: "fp32", modelFileName: "decoder_model_merged", subfolder: "" });
          }
        }
      }

      const failures: string[] = [];

      for (const attempt of attempts) {
        try {
          const config = await this.fetchPatchedGemma4Config(attempt.modelId);
          this.generator = (await createPipeline("text-generation", attempt.modelId, {
            device: attempt.device,
            dtype: attempt.dtype,
            config: config as never,
            model_file_name: attempt.modelFileName,
            subfolder: attempt.subfolder,
            use_external_data_format: attempt.useExternalDataFormat,
            progress_callback: (progress: Record<string, unknown>) => {
              onProgress?.({
                ...progress,
                model: attempt.modelId,
                device: attempt.device,
                dtype: attempt.dtype,
                file: attempt.modelFileName ?? "model",
                subfolder: attempt.subfolder ?? "onnx",
                externalDataChunks: attempt.useExternalDataFormat ?? 0,
              });
            },
          })) as GeneratorFn;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(
            `${attempt.modelId} (${attempt.device}/${attempt.dtype}, file=${attempt.modelFileName ?? "model"}, subfolder=${attempt.subfolder ?? "onnx"}): ${message}`,
          );
        }
      }

      if (!this.generator) {
        const memoryNote = canTryFp32Merged
          ? ""
          : " Heavy fp32 merged-model attempts were skipped for E4B because device memory appears limited (<12GB).";
        const webGpuNote = `WebGPU detected but Gemma 4 variants could not initialize.${memoryNote}`;
        throw new Error(`Unable to load any Gemma 4 fallback. ${webGpuNote} Attempts: ${failures.join(" | ")}`);
      }
    })();

    return this.loadPromise;
  }

  async generate(options: GenerateOptions): Promise<unknown> {
    await this.load(options.onProgress);

    if (!this.generator) {
      throw new Error("Model not loaded");
    }

    const output = await this.generator(options.messages, {
      max_new_tokens: options.max_new_tokens ?? 512,
      tools: options.tools ?? undefined,
      do_sample: false,
      return_dict_in_generate: false,
      streamer: {
        put: (token: string) => {
          options.onToken?.(token);
        },
        end: () => {
          // no-op
        },
      },
    });

    if (output?.[0]?.generated_text) {
      return output[0].generated_text.at(-1);
    }

    return null;
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
  const { runTool, TOOL_REGISTRY } = await import("@/lib/tools/registry");

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
