import * as duckdb from "@duckdb/duckdb-wasm";

let db: duckdb.AsyncDuckDB | null = null;

async function ensureDb() {
  if (db) return db;

  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: { query?: string; dataUrl?: string };
  };

  try {
    if (type === "run") {
      const instance = await ensureDb();
      const conn = await instance.connect();

      if (payload.dataUrl) {
        await conn.query(`CREATE OR REPLACE TABLE input_data AS SELECT * FROM read_csv_auto('${payload.dataUrl}')`);
      }

      const query = payload.query || "SELECT 1 as value";
      const result = await conn.query(query);
      const columns = result.schema.fields.map((f) => f.name);
      const rows = result.toArray().map((row) => {
        const resolved =
          typeof (row as { toJSON?: () => Record<string, unknown> }).toJSON === "function"
            ? (row as { toJSON: () => Record<string, unknown> }).toJSON()
            : (row as Record<string, unknown>);
        return columns.map((key) => resolved[key]);
      });
      await conn.close();

      self.postMessage({ type: "result", id, payload: { columns, rows } });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", id, payload: String(err) });
  }
};
