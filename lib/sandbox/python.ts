type PythonResult = { stdout: string; chart: string | null };

const TIMEOUT_MS = 120_000;

class PythonManager {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../../workers/pyodide.worker.ts", import.meta.url));
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, payload } = e.data as {
          type: string;
          id: string;
          payload: unknown;
        };
        const h = this.pending.get(id);
        if (!h) return;

        if (type === "ready" || type === "result") {
          this.pending.delete(id);
          h.resolve(payload ?? null);
        }
        if (type === "error") {
          this.pending.delete(id);
          h.reject(new Error(String(payload)));
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
        reject(new Error(`Python call timed out (${type})`));
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
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.call("init", {}) as Promise<void>;
    return this.initPromise;
  }

  async runPython(code: string): Promise<PythonResult> {
    await this.init();
    const res = (await this.call("run", { code })) as PythonResult;
    return {
      stdout: String(res?.stdout ?? ""),
      chart: res?.chart ?? null,
    };
  }
}

const manager = new PythonManager();

export async function runPython(code: string): Promise<PythonResult> {
  return manager.runPython(code);
}
