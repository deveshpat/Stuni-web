import { fetchUrl, searchWeb } from "@/lib/research";
import { runPython } from "@/lib/sandbox/python";
import { runR } from "@/lib/sandbox/r";
import { runSQL } from "@/lib/sandbox/sql";
import { compileLatex } from "@/lib/sandbox/latex";
import { jsSandbox } from "@/lib/sandbox/js-sandbox";

export type ToolName =
  | "search_web"
  | "fetch_url"
  | "run_python"
  | "run_r"
  | "run_sql"
  | "compile_latex"
  | "run_javascript";

export type ToolDefinition = {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
};

export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    name: "search_web",
    description: "Search the web for recent information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch and read content from a URL as markdown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "run_python",
    description: "Execute Python code using Pyodide.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "run_r",
    description: "Execute R code using WebR.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "run_sql",
    description: "Execute SQL query with DuckDB WASM.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        dataUrl: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "compile_latex",
    description: "Compile LaTeX source and return a PDF blob URL.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string" },
      },
      required: ["source"],
    },
  },
  {
    name: "run_javascript",
    description: "Run JavaScript animation/visualization code in a sandboxed iframe.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        libraries: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["code"],
    },
  },
];

export async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name as ToolName) {
    case "search_web":
      return searchWeb(String(args.query || ""));
    case "fetch_url":
      return fetchUrl(String(args.url || ""));
    case "run_python":
      return runPython(String(args.code || ""));
    case "run_r":
      return runR(String(args.code || ""));
    case "run_sql":
      return runSQL(String(args.query || ""), args.dataUrl ? String(args.dataUrl) : undefined);
    case "compile_latex": {
      const blob = await compileLatex(String(args.source || ""));
      return {
        kind: "pdf",
        url: URL.createObjectURL(blob),
      };
    }
    case "run_javascript": {
      const iframe = jsSandbox.getIframe();
      const host =
        document.getElementById("js-sandbox-host") ||
        document.body;
      if (!host.contains(iframe)) {
        host.appendChild(iframe);
      }
      const libraries = Array.isArray(args.libraries)
        ? args.libraries.map((item) => String(item))
        : [];
      await jsSandbox.run({
        code: String(args.code || ""),
        libraries,
      });
      return { ok: true, message: "Sandbox execution complete" };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
