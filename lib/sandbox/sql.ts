type SqlResult = { columns: string[]; rows: unknown[][] };

const TIMEOUT_MS = 120_000;

class SqlManager {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../../workers/duckdb.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, payload } = e.data as { type: string; id: string; payload: unknown };
        const request = this.pending.get(id);
        if (!request) return;

        if (type === "result") {
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

  private call(payload: { query: string; dataUrl?: string }): Promise<SqlResult> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("SQL query timed out"));
      }, TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as SqlResult);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.getWorker().postMessage({ type: "run", id, payload });
    });
  }

  async runSQL(query: string, dataUrl?: string): Promise<SqlResult> {
    return this.call({ query, dataUrl });
  }
}

const manager = new SqlManager();

export async function runSQL(query: string, dataUrl?: string): Promise<SqlResult> {
  return manager.runSQL(query, dataUrl);
}
