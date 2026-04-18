const TIMEOUT_MS = 120_000;

class LatexManager {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../../workers/latex.worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, payload } = e.data as {
          type: string;
          id: string;
          payload: unknown;
        };

        const p = this.pending.get(id);
        if (!p) return;

        if (type === "ready" || type === "pdf") {
          this.pending.delete(id);
          p.resolve(payload ?? null);
        }

        if (type === "error") {
          this.pending.delete(id);
          p.reject(new Error(String(payload)));
        }
      };
    }

    return this.worker;
  }

  private call(type: string, payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LaTeX call timed out (${type})`));
      }, TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.getWorker().postMessage({ type, id, payload });
    });
  }

  async init(): Promise<void> {
    if (this.ready) return this.ready;
    const probe = await fetch("/swiftlatex/PdfTeXEngine.js", { method: "HEAD" });
    if (!probe.ok) {
      throw new Error(
        "SwiftLaTeX assets missing. Add PdfTeXEngine.js and required .wasm files under public/swiftlatex/.",
      );
    }
    this.ready = this.call("init", {}) as Promise<void>;
    return this.ready;
  }

  async compile(source: string): Promise<Blob> {
    await this.init();
    const pdfBuffer = (await this.call("compile", { source })) as ArrayBuffer;
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }
}

const manager = new LatexManager();

export async function compileLatex(source: string): Promise<Blob> {
  return manager.compile(source);
}
