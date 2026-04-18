type RunOptions = {
  code: string;
  libraries?: string[];
};

const TIMEOUT_MS = 120_000;

class JsSandboxManager {
  private iframe: HTMLIFrameElement | null = null;
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private handlerInstalled = false;

  private ensureHandler() {
    if (this.handlerInstalled || typeof window === "undefined") return;
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string; id?: string; payload?: unknown };
      if (!data?.id || !this.pending.has(data.id)) return;
      const request = this.pending.get(data.id);
      if (!request) return;

      if (data.type === "done") {
        this.pending.delete(data.id);
        request.resolve();
      }
      if (data.type === "error") {
        this.pending.delete(data.id);
        request.reject(new Error(String(data.payload ?? "Sandbox error")));
      }
    });
    this.handlerInstalled = true;
  }

  getIframe(): HTMLIFrameElement {
    if (!this.iframe) {
      const iframe = document.createElement("iframe");
      iframe.src = "/js-sandbox.html";
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.style.width = "100%";
      iframe.style.height = "420px";
      iframe.style.border = "0";
      this.iframe = iframe;
      this.ensureHandler();
    }
    return this.iframe;
  }

  async run(options: RunOptions): Promise<void> {
    this.ensureHandler();
    const iframe = this.getIframe();
    const id = crypto.randomUUID();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("JS sandbox timed out"));
      }, TIMEOUT_MS);

      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const post = () =>
        iframe.contentWindow?.postMessage(
          { type: "run", code: options.code, libraries: options.libraries ?? [], id },
          "*",
        );

      if (iframe.contentWindow) {
        post();
      } else {
        iframe.addEventListener("load", post, { once: true });
      }
    });
  }
}

export const jsSandbox = new JsSandboxManager();
