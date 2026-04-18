import { WebR } from "webr";

let webR: WebR | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: { code?: string };
  };

  try {
    if (type === "init") {
      if (!webR) {
        webR = new WebR();
        await webR.init();
      }
      self.postMessage({ type: "ready", id });
      return;
    }

    if (type === "run") {
      if (!webR) {
        self.postMessage({ type: "error", id, payload: "R runtime not initialized" });
        return;
      }

      const runtime = webR as unknown as {
        evalRString?: (code: string) => Promise<unknown>;
        evalR?: (code: string) => Promise<{ toString: () => string }>;
      };

      let output = "";
      if (runtime.evalRString) {
        output = String(await runtime.evalRString(payload.code || ""));
      } else if (runtime.evalR) {
        const result = await runtime.evalR(payload.code || "");
        output = result?.toString?.() || "";
      }

      self.postMessage({ type: "result", id, payload: { stdout: output } });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", id, payload: String(err) });
  }
};
