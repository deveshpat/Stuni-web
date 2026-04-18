type RResult = { stdout: string; plot?: string | null };

const TIMEOUT_MS = 120_000;

class RManager {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../../workers/webr.worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, payload } = e.data as { type: string; id: string; payload: unknown };
        const request = this.pending.get(id);
        if (!request) return;

        if (type === "ready" || type === "result") {
          this.pending.delete(id);
          request.resolve(payload);
        }
        if (type === "error") {
          this.pending.delete(id);
          request.reject(new Error(String(payload)));
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
        reject(new Error(`R call timed out (${type})`));
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

  async runR(code: string): Promise<RResult> {
    await this.init();
    const result = (await this.call("run", { code })) as RResult;
    return {
      stdout: String(result?.stdout ?? ""),
      plot: result?.plot ?? null,
    };
  }
}

const manager = new RManager();

export async function runR(code: string): Promise<RResult> {
  return manager.runR(code);
}
