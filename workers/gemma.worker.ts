import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.useBrowserCache = true;

const MODEL_ID = "onnx-community/gemma-4-E4B-it-ONNX";
const DTYPE_WEBGPU = "q4f16";
const DTYPE_WASM = "q4f16";

type DType = "q4f16" | "fp32";

type ProgressPayload = Record<string, unknown>;

type GeneratorFn = (
  input: unknown,
  options: Record<string, unknown>,
) => Promise<Array<{ generated_text: unknown[] }>>;

let generator: GeneratorFn | null = null;

async function loadGenerator(
  id: string,
  dtype: DType,
  device: "webgpu" | "wasm",
  requestId: string,
  config?: unknown,
  modelFileName?: string,
  subfolder?: string,
) {
  return pipeline("text-generation", id, {
    dtype,
    device,
    config: config as never,
    model_file_name: modelFileName,
    subfolder,
    progress_callback: (progress: ProgressPayload) => {
      self.postMessage({ type: "progress", id: requestId, payload: progress });
    },
  });
}

async function fetchPatchedGemma4Config(): Promise<Record<string, unknown>> {
  const response = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/config.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Gemma 4 config: ${response.status}`);
  }

  const config = (await response.json()) as Record<string, unknown>;
  // transformers.js may not yet recognize `gemma4`; `gemma3_text` is the closest supported text-only class.
  config.model_type = "gemma3_text";
  // Avoid inheriting restrictive device hints from upstream config in compatibility mode.
  delete config["transformers.js_config"];
  return config;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  };

  if (type === "load") {
    const failures: string[] = [];
    const attempts: Array<{
      device: "webgpu" | "wasm";
      dtype: DType;
      compatMode: boolean;
      modelFileName?: string;
      subfolder?: string;
    }> = [
      { device: "webgpu", dtype: DTYPE_WEBGPU, compatMode: false },
      { device: "webgpu", dtype: "fp32", compatMode: true, modelFileName: "decoder_model_merged" },
      { device: "webgpu", dtype: "fp32", compatMode: true, modelFileName: "decoder_model_merged", subfolder: "" },
      { device: "wasm", dtype: DTYPE_WASM, compatMode: false },
      { device: "wasm", dtype: DTYPE_WASM, compatMode: true },
      { device: "wasm", dtype: "fp32", compatMode: true },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "model_q4f16" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "model_quantized" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "decoder_model_merged" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "model", subfolder: "" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "model_q4f16", subfolder: "" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "model_quantized", subfolder: "" },
      { device: "wasm", dtype: "fp32", compatMode: true, modelFileName: "decoder_model_merged", subfolder: "" },
    ];

    for (const attempt of attempts) {
      try {
        const config = attempt.compatMode ? await fetchPatchedGemma4Config() : undefined;
        generator = (await loadGenerator(
          MODEL_ID,
          attempt.dtype,
          attempt.device,
          id,
          config,
          attempt.modelFileName,
          attempt.subfolder,
        )) as GeneratorFn;
        self.postMessage({
          type: "loaded",
          id,
          payload: {
            model: MODEL_ID,
            dtype: attempt.dtype,
            device: attempt.device,
            compatMode: attempt.compatMode,
            modelFileName: attempt.modelFileName ?? null,
            subfolder: attempt.subfolder ?? "onnx",
          },
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(
          `${MODEL_ID} (${attempt.device}/${attempt.dtype}, compat=${attempt.compatMode}, file=${attempt.modelFileName ?? "model"}, subfolder=${attempt.subfolder ?? "onnx"}): ${msg}`,
        );
      }
    }

    if (!generator) {
      self.postMessage({
        type: "error",
        id,
        payload: `Unable to load any local text model. Attempts: ${failures.join(" | ")}`,
      });
    }
  }

  if (type === "generate") {
    if (!generator) {
      self.postMessage({ type: "error", id, payload: "Model not loaded" });
      return;
    }

    try {
      const { messages, tools, max_new_tokens = 512 } = payload;
      const output = await generator(messages, {
        max_new_tokens,
        tools: tools ?? undefined,
        do_sample: false,
        return_dict_in_generate: false,
        streamer: {
          put: (token: string) => {
            self.postMessage({ type: "token", id, payload: token });
          },
          end: () => {
            self.postMessage({ type: "done", id });
          },
        },
      });

      if (output?.[0]?.generated_text) {
        const last = output[0].generated_text.at(-1);
        self.postMessage({ type: "result", id, payload: last });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: "error", id, payload: msg });
    }
  }
};
