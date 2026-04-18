import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.useBrowserCache = true;

const MODEL_ID = "onnx-community/gemma-4-E4B-it-ONNX";
const DTYPE = "q4f16";

type ProgressPayload = Record<string, unknown>;

type GeneratorFn = (
  input: unknown,
  options: Record<string, unknown>,
) => Promise<Array<{ generated_text: unknown[] }>>;

let generator: GeneratorFn | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  };

  if (type === "load") {
    try {
      generator = await pipeline("text-generation", MODEL_ID, {
        dtype: DTYPE,
        device: "webgpu",
        progress_callback: (progress: ProgressPayload) => {
          self.postMessage({ type: "progress", id, payload: progress });
        },
      });
      self.postMessage({ type: "loaded", id });
    } catch {
      try {
        generator = await pipeline("text-generation", MODEL_ID, {
          dtype: "q8",
          device: "wasm",
          progress_callback: (progress: ProgressPayload) => {
            self.postMessage({ type: "progress", id, payload: progress });
          },
        });
        self.postMessage({ type: "loaded", id, payload: { fallback: "wasm" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: "error", id, payload: msg });
      }
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
