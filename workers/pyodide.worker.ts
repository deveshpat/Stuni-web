importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js");

declare const loadPyodide: (opts: { indexURL: string }) => Promise<{
  runPythonAsync: (code: string) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<void>;
}>;

type PyodideProxyLike = {
  toJs?: (options?: Record<string, unknown>) => unknown;
  destroy?: () => void;
};

let pyodide: Awaited<ReturnType<typeof loadPyodide>> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: { code?: string };
  };

  if (type === "init") {
    try {
      pyodide = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.0/full/",
      });
      self.postMessage({ type: "ready", id });
    } catch (err) {
      self.postMessage({ type: "error", id, payload: String(err) });
    }
    return;
  }

  if (type === "run") {
    if (!pyodide) {
      self.postMessage({ type: "error", id, payload: "Not initialized" });
      return;
    }

    try {
      const code = payload.code || "";
      await pyodide.loadPackagesFromImports(code);
      const rawResult = (await pyodide.runPythonAsync(`
import io
import contextlib
import base64

_stdout = io.StringIO()
_chart = ""

with contextlib.redirect_stdout(_stdout), contextlib.redirect_stderr(_stdout):
    exec(${JSON.stringify(code)}, {})

try:
    import matplotlib.pyplot as plt
    fig = plt.gcf()
    if fig and fig.axes:
        _buf = io.BytesIO()
        plt.savefig(_buf, format='png', bbox_inches='tight', dpi=150)
        plt.close('all')
        _buf.seek(0)
        _chart = base64.b64encode(_buf.read()).decode()
except Exception:
    pass

{"stdout": _stdout.getvalue(), "chart": _chart}
`)) as unknown;

      const proxy = rawResult as PyodideProxyLike;
      const result =
        proxy && typeof proxy === "object" && typeof proxy.toJs === "function"
          ? (proxy.toJs({ dict_converter: Object.fromEntries }) as {
              stdout?: string;
              chart?: string;
            })
          : ((rawResult as {
              stdout?: string;
              chart?: string;
            }) ?? {});

      if (proxy && typeof proxy === "object" && typeof proxy.destroy === "function") {
        proxy.destroy();
      }

      self.postMessage({
        type: "result",
        id,
        payload: {
          stdout: String(result?.stdout || ""),
          chart: result?.chart || null,
        },
      });
    } catch (err) {
      self.postMessage({ type: "error", id, payload: String(err) });
    }
  }
};
