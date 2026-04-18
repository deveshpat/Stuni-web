# stuni-web v2 — Project Blueprint
> Living document. Update after every session. Check off items as completed.
> Last updated: 2026-04-18 (Session 3 — Agent-Reach + polyglot sandbox research)

---

## 0. Context Summary (for new threads)

**What this is:** A Next.js browser app generating AI-narrated explainer videos, with a companion agentic chat page. The entire intelligence stack runs locally — no cloud inference, no API keys, no cost.

**Current v1:** OpenRouter (server) → Xenova TTS (server) → FFmpeg.wasm (client). Single page.
**Target v2:** Gemma 4 E4B WebGPU (browser) → polyglot sandbox (Python/R/SQL/LaTeX/JS) → Jina research → IndexedDB memory → same TTS + FFmpeg pipeline + `/chat` route.

---

## 1. Research Findings

### 1.1 Gemma 4 — Browser-Ready, Apache 2.0

Released April 2025. The E4B (4B effective params) runs in-browser via Transformers.js + WebGPU.

| Model | Text ONNX size | Context | Audio in | Function calling |
|-------|---------------|---------|----------|-----------------|
| E2B   | ~500MB q4f16  | 128K    | ✅        | ✅               |
| E4B   | ~1.5GB q4f16  | 128K    | ✅        | ✅               |

- ONNX: `onnx-community/gemma-4-E4B-it-ONNX`
- WebGPU demo working: huggingface.co/spaces/webml-community/Gemma-4-WebGPU
- Reference browser agent using it: github.com/kessler/gemma-gem

**⚠️ Audio = INPUT only.** Gemma 4 understands speech but cannot generate it. `@xenova/mms-tts-eng` stays.

---

### 1.2 Agent-Reach — Verdict: Concept Yes, Implementation No

**What it is:** `Panniantong/Agent-Reach` — a CLI tool giving AI agents access to Twitter, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu with zero API fees.

**How it works:** Modular Python CLI. Each platform is one standalone file using upstream scrapers: `twitter-cli`, `rdt-cli`, `xhs-cli`, `bili-cli`, `yt-dlp`, Jina Reader, Exa, mcporter. MCP-compatible.

**Why we can't use it directly:** It's a Python + Node.js desktop tool requiring a host machine. Runs `playwright`/`puppeteer` under the hood. Not browser-native. No WASM port exists.

**What we take from it:**
- The *concept* of a unified multi-platform search layer → we implement our own browser-native version
- The *modular channel architecture* (one file per platform) → we mirror this in `lib/research/`

**Our browser-native "Agent-Reach lite" via Jina:**

| Platform | Jina URL pattern | Quality |
|----------|-----------------|---------|
| Any webpage | `r.jina.ai/https://example.com` | ✅ Excellent |
| Web search | `s.jina.ai/your+query` (top 5 results) | ✅ Excellent |
| Reddit public | `r.jina.ai/https://old.reddit.com/r/topic/` | ✅ Good |
| GitHub repos | `r.jina.ai/https://github.com/user/repo` | ✅ Good |
| GitHub search | `r.jina.ai/https://github.com/search?q=query` | ⚠️ Partial |
| X/Twitter | `r.jina.ai/https://x.com/username` | ⚠️ Login-walled |
| YouTube | `r.jina.ai/https://youtube.com/results?search_query=q` | ⚠️ Titles only |
| arXiv papers | `r.jina.ai/https://arxiv.org/abs/PAPER_ID` | ✅ Full text |
| Wikipedia | `r.jina.ai/https://en.wikipedia.org/wiki/Topic` | ✅ Excellent |

**Rate limit:** 20 RPM keyless. Add 3s queue delay. Cache in IndexedDB.

---

### 1.3 Polyglot Sandbox — Full Language Matrix

Every runtime runs in a **Web Worker** (never the main thread). All are lazy-loaded on first use and cached. Gemma decides which runtime to invoke via function calling.

| Language | Engine | Size | What Gemma uses it for |
|----------|--------|------|------------------------|
| **Python** | Pyodide v0.29 | ~15MB | Data analysis, ML, algorithms, plots, simulations |
| **R** | WebR | ~40MB | Statistics, ggplot2, Bayesian inference, bioinformatics |
| **SQL** | DuckDB WASM | ~8MB | Analytical queries on CSV/Parquet/JSON |
| **SQL** | wa-sqlite (OPFS) | ~3MB | Transactional local-first data storage |
| **LaTeX** | SwiftLaTeX (PdfTeX/XeTeX) | ~10MB | Academic PDFs, math papers, formatted documents |
| **LaTeX (full)** | texlyre-busytex | ~175MB | TeX Live 2025: LuaTeX, complex packages, BibTeX |
| **JavaScript** | Native browser | 0MB | Animations, DOM interaction, real-time |

**JavaScript sub-runtimes (loaded dynamically into sandboxed iframe):**

| Library | CDN size | Use case |
|---------|----------|----------|
| Three.js | ~600KB | 3D scenes, physics, games, simulations |
| p5.js | ~900KB | Creative coding, generative art, interactive sketches |
| D3.js | ~500KB | Data visualizations, custom charts, network graphs |
| Manim-web | ~400KB | Mathematical animations (3Blue1Brown-style, WebGL) |
| Matter.js | ~200KB | 2D rigid body physics |
| Plotly.js | ~3MB | Scientific charts, surface plots, statistical viz |
| Anime.js | ~20KB | DOM/SVG animations, timeline-based transitions |
| KaTeX | ~400KB | Fast LaTeX math equation rendering |
| Mermaid.js | ~400KB | Diagrams from markdown (flowchart, ER, sequence) |

**Python packages available without install (pre-compiled in Pyodide):**
NumPy, Pandas, Matplotlib, SciPy, scikit-learn, Pillow, regex, PyYAML, SymPy, Shapely, NetworkX, Plotly (Python), statsmodels

**Key constraint:** Python code in Pyodide cannot make network requests via `urllib`/`requests`. Use `js.fetch()` bridge for any HTTP call needed from Python.

---

### 1.4 LaTeX → PDF Pipeline

SwiftLaTeX (recommended — 10MB, just works):
```js
import { PdfTeXEngine } from 'swiftlatex';
const engine = new PdfTeXEngine();
await engine.loadEngine();
engine.writeMemFSFile('main.tex', latexSource);
engine.setEngineMainFile('main.tex');
const result = await engine.compileLaTeX();
// result.pdf is a Uint8Array → create Blob → display in iframe / trigger download
```

texlyre-busytex (for complex documents, 175MB assets):
```js
import { BusyTexRunner, XeLatex } from 'texlyre-busytex';
const runner = new BusyTexRunner({ busytexBasePath: '/core/busytex' });
await runner.initialize();
const xelatex = new XeLatex(runner);
const result = await xelatex.compile({ input: latexSource });
```

**Decision rule:** Default to SwiftLaTeX. Only load texlyre-busytex if the user explicitly needs LuaTeX or complex package support (beamer, tikz, etc.).

---

### 1.5 Memory System

MemPalace (Milla Jovovich's project) — inspirational but wrong tool:
- 96.6% recall on LongMemEval (real result)
- Requires Python, ChromaDB, MCP — no browser port
- Benchmark controversy: headline 100% achieved by retrieving entire dataset (not scalable)
- Architecture concept (wings → rooms → drawers) is worth copying in TypeScript

**Our implementation:** IndexedDB + MiniLM embeddings + MemPalace hierarchy in TypeScript.

---

## 2. Resolved Questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Gemma 4 real and browser-compatible? | ✅ Yes — ONNX q4f16 via Transformers.js WebGPU |
| 2 | Audio from Gemma 4? | ❌ Input only. Keep Xenova TTS |
| 3 | Agent-Reach usable in browser? | ❌ Python CLI. Use Jina as browser-native equivalent |
| 4 | Internet access method? | Jina Reader (`r.jina.ai`) + Search (`s.jina.ai`) |
| 5 | Code execution runtimes? | Pyodide (Python), WebR (R), DuckDB (SQL), SwiftLaTeX (LaTeX), native iframe (JS) |
| 6 | LaTeX for PDFs? | ✅ SwiftLaTeX (10MB, PdfTeX/XeTeX in WASM) |
| 7 | JS animations/simulations? | ✅ Three.js, p5.js, D3.js, Manim-web, Matter.js via sandboxed iframe |
| 8 | Memory system? | IndexedDB + MiniLM + MemPalace hierarchy in TS |
| 9 | Chat page? | Separate `/chat` route |
| 10 | Remove all API routes? | ✅ Yes, fully client-side |

---

## 3. Confirmed Architecture — v2

```
Browser Tab
│
├── [Web Worker: gemma.worker.ts]
│   └── Gemma 4 E4B ONNX q4f16 — WebGPU / WASM fallback
│       ├── Text generation + streaming
│       ├── Native function calling (tool dispatch)
│       └── Built-in thinking mode
│
├── [Web Worker: pyodide.worker.ts]     — lazy loaded
│   └── Pyodide CPython 3.11 WASM
│
├── [Web Worker: webr.worker.ts]        — lazy loaded
│   └── WebR (R language WASM)
│
├── [Web Worker: duckdb.worker.ts]      — lazy loaded
│   └── DuckDB WASM (analytical SQL)
│
├── [Web Worker: latex.worker.ts]       — lazy loaded
│   └── SwiftLaTeX (PdfTeX/XeTeX WASM)
│
├── [Web Worker: tts.worker.ts]         — UNCHANGED FROM V1
│   └── @xenova/mms-tts-eng
│
├── [Sandboxed iframe: js-sandbox.html] — lazy loaded
│   └── Three.js / p5.js / D3.js / Manim-web / Matter.js / Plotly
│       Loaded dynamically per-request from CDN
│
├── [Main Thread]
│   ├── /page        — Video Generator (refactored: local Gemma)
│   ├── /chat        — Agent Chat UI (NEW)
│   ├── FFmpeg.wasm  — Video encode (UNCHANGED)
│   ├── Canvas       — Slide render (UNCHANGED)
│   └── IndexedDB    — Memory store
│
└── [External: fetch() from main thread]
    ├── r.jina.ai/[url]   — fetch any URL → markdown
    └── s.jina.ai/[query] — web search → top 5 results
```

**Server-side after v2:** Zero API routes. Next.js serves static files only.
**Eliminated:** `/api/script`, `/api/tts`, all OpenRouter env vars.

---

## 4. Risk Register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| WebGPU unavailable (Safari, old Chrome) | High | WASM CPU fallback. Banner warning. ~5 tok/s vs ~50 tok/s. |
| E4B 1.5GB first load | Medium | Download progress bar. Service Worker cache. Prompt "model downloading" UX. |
| OOM: running Gemma + Pyodide + FFmpeg simultaneously | High | Strict lifecycle: terminate Pyodide worker when done. Never run FFmpeg + Gemma at same time. |
| LaTeX texlyre-busytex 175MB | High | Only load on explicit request. Default to SwiftLaTeX (10MB). |
| WebR 40MB load time | Medium | Lazy-load only when R code detected. Show progress. |
| COEP headers blocking Jina fetch | High | Must resolve before Phase 6. Either route Jina through thin `/api/proxy` or use conditional COEP per-page. |
| Jina 20 RPM rate limit | Low | IndexedDB cache. 3s queue delay between requests. |
| JS sandbox XSS/code injection | Medium | Run all user JS in sandboxed iframe with `sandbox` attribute. No `allow-same-origin`. |
| Python socket-based network requests | Low | Document clearly. Bridge all HTTP via `js.fetch()`. |

---

## 5. File Structure — v2

```
stuni-web/
├── app/
│   ├── page.tsx              ← refactor: local Gemma, remove OpenRouter calls
│   ├── chat/
│   │   └── page.tsx          ← NEW: agent chat + code execution UI
│   ├── layout.tsx            ← unchanged
│   └── globals.css           ← unchanged
│
├── lib/
│   ├── gemma.ts              ← NEW: Gemma 4 worker manager + agent loop
│   ├── memory.ts             ← NEW: IndexedDB + MiniLM (MemPalace-inspired)
│   ├── research/
│   │   ├── index.ts          ← NEW: unified research API
│   │   ├── search.ts         ← NEW: s.jina.ai wrapper
│   │   ├── fetch.ts          ← NEW: r.jina.ai wrapper
│   │   └── channels/         ← NEW: per-platform helpers (Reddit, GitHub, arXiv…)
│   ├── sandbox/
│   │   ├── index.ts          ← NEW: runtime dispatcher
│   │   ├── python.ts         ← NEW: Pyodide worker manager
│   │   ├── r.ts              ← NEW: WebR worker manager
│   │   ├── sql.ts            ← NEW: DuckDB worker manager
│   │   ├── latex.ts          ← NEW: SwiftLaTeX worker manager
│   │   └── js-sandbox.ts     ← NEW: iframe sandbox manager
│   ├── tts.ts                ← NEW: extract TTS from page.tsx
│   └── tools/
│       └── registry.ts       ← NEW: Gemma tool definitions (JSON schema)
│
├── workers/
│   ├── gemma.worker.ts       ← NEW: Gemma 4 ONNX in Web Worker
│   ├── pyodide.worker.ts     ← NEW: Pyodide CPython
│   ├── webr.worker.ts        ← NEW: WebR R language
│   ├── duckdb.worker.ts      ← NEW: DuckDB WASM
│   ├── latex.worker.ts       ← NEW: SwiftLaTeX
│   └── tts.worker.ts         ← NEW: Xenova TTS (extracted from page.tsx)
│
├── public/
│   └── js-sandbox.html       ← NEW: sandboxed iframe for JS execution
│
├── types/
│   └── agent.ts              ← NEW: Message, ToolCall, MemoryEntry, SandboxResult
│
├── app/api/                  ← DELETE all routes in v2
│
├── next.config.mjs           ← update: COOP/COEP headers + webpack aliases
├── package.json              ← add: idb; update: @huggingface/transformers
└── .env                      ← strip all OPENROUTER_* and remote TTS vars
```

---

## 6. Tool Registry — Gemma Function Calling Schema

```typescript
// lib/tools/registry.ts
export const TOOL_REGISTRY = [
  {
    name: "search_web",
    description: "Search the internet and get full content of top results. Use for current events, research, documentation.",
    parameters: { query: "string" }
  },
  {
    name: "fetch_url",
    description: "Read the full content of a URL as clean markdown. Use for specific articles, GitHub repos, arXiv papers, Wikipedia.",
    parameters: { url: "string" }
  },
  {
    name: "execute_python",
    description: "Run Python code. Has NumPy, Pandas, Matplotlib, SciPy, scikit-learn. Returns stdout + any charts as PNG.",
    parameters: { code: "string" }
  },
  {
    name: "execute_r",
    description: "Run R statistical code. Has ggplot2, tidyverse, stats packages. Returns console output + plots as PNG.",
    parameters: { code: "string" }
  },
  {
    name: "execute_sql",
    description: "Run SQL (DuckDB dialect) on CSV/Parquet/JSON data. Returns table results.",
    parameters: { query: "string", data_url: "string?" }
  },
  {
    name: "execute_javascript",
    description: "Run JavaScript with access to Three.js, p5.js, D3.js, Manim-web, Matter.js, Plotly. Returns canvas/animation in iframe.",
    parameters: { code: "string", libraries: "string[]?" }
  },
  {
    name: "compile_latex",
    description: "Compile LaTeX source to PDF. Returns downloadable PDF blob.",
    parameters: { source: "string", engine: "'pdftex'|'xetex'|'luatex'?" }
  },
  {
    name: "generate_video",
    description: "Create a narrated explainer video from a topic.",
    parameters: { topic: "string" }
  },
  {
    name: "recall_memory",
    description: "Search your memory for past conversations and context.",
    parameters: { query: "string" }
  },
  {
    name: "store_memory",
    description: "Save important information to memory for future sessions.",
    parameters: { content: "string", wing: "string?", room: "string?" }
  }
];
```

---

## 7. Implementation Phases

### Phase 1 — Gemma 4 Local Inference
**Status:** ⬜ Not started

- Load `onnx-community/gemma-4-E4B-it-ONNX` (q4f16) in Web Worker via `@huggingface/transformers`
- Streaming token output to UI
- Replace `/api/script` call in `page.tsx` with local Gemma
- Download progress UI (one-time, Service Worker cache after)
- WebGPU detection + WASM CPU fallback
- Delete `/app/api/script/route.ts`

Key references: gemma-gem, onyx, HF WebGPU demo

---

### Phase 2 — Client-side TTS
**Status:** ⬜ Not started

- Extract TTS from `page.tsx` → `workers/tts.worker.ts` + `lib/tts.ts`
- Delete `/app/api/tts/route.ts`
- Remove `NEXT_PUBLIC_AUDIO_PROVIDER` complexity (always local now)

---

### Phase 3 — Research Tools (Agent-Reach lite)
**Status:** ⬜ Not started

- `lib/research/search.ts` → `fetch("https://s.jina.ai/...")`
- `lib/research/fetch.ts` → `fetch("https://r.jina.ai/...")`
- `lib/research/channels/` → per-platform helpers for Reddit, GitHub, arXiv, Wikipedia
- 3s request queue + IndexedDB cache for rate limit protection
- Register as Gemma tools `search_web` + `fetch_url`

---

### Phase 4 — Python Sandbox (Pyodide)
**Status:** ⬜ Not started

- `workers/pyodide.worker.ts` — CPython in Web Worker
- `lib/sandbox/python.ts` — manager + result parser
- Chart capture: matplotlib → `io.BytesIO` → base64 sentinel → JS displays PNG
- Register as `execute_python` tool
- Test: data analysis, plotting, algorithm simulation

---

### Phase 5 — JavaScript Sandbox (iframe)
**Status:** ⬜ Not started

- `public/js-sandbox.html` — sandboxed iframe (`sandbox="allow-scripts"`, NO `allow-same-origin`)
- `lib/sandbox/js-sandbox.ts` — message-based API to iframe
- Dynamic library loading: Gemma specifies `libraries: ["three", "p5"]` → iframe loads from CDN
- Available: Three.js, p5.js, D3.js, Manim-web, Matter.js, Plotly, Anime.js, KaTeX, Mermaid
- Register as `execute_javascript` tool

---

### Phase 6 — LaTeX Sandbox
**Status:** ⬜ Not started

- `workers/latex.worker.ts` — SwiftLaTeX PdfTeX/XeTeX WASM
- `lib/sandbox/latex.ts` — manager + PDF blob handler
- texlyre-busytex: lazy-load only on LuaTeX request
- Register as `compile_latex` tool
- Output: PDF Blob → download button + iframe preview

---

### Phase 7 — R Sandbox (WebR)
**Status:** ⬜ Not started

- `workers/webr.worker.ts` — R WASM runtime
- `lib/sandbox/r.ts` — manager
- ggplot2 output → PNG → display
- Register as `execute_r` tool

---

### Phase 8 — SQL Sandbox (DuckDB)
**Status:** ⬜ Not started

- `workers/duckdb.worker.ts` — DuckDB WASM
- `lib/sandbox/sql.ts` — manager + result → table UI
- Support: query from URL (Parquet/CSV), from user-uploaded file, or in-memory
- Register as `execute_sql` tool

---

### Phase 9 — Memory System
**Status:** ⬜ Not started

- Install `idb` package
- `lib/memory.ts` — IndexedDB + MiniLM `Xenova/all-MiniLM-L6-v2` (23MB)
- Wings → Rooms → Drawers hierarchy (MemPalace-inspired)
- L0 (~50 tokens) + L1 (~120 tokens) loaded at startup
- L2/L3 on-demand semantic search
- Register as `recall_memory` + `store_memory` tools

---

### Phase 10 — Chat Page + Full Agent Loop
**Status:** ⬜ Not started

- `/app/chat/page.tsx` — full-screen agent chat UI
- Agent loop: message → context build → Gemma → tool dispatch → results → Gemma → response → memory store
- Output rendering: streamed markdown, code blocks, PNG charts, PDF preview, iframe animations, video player
- Navigation: header link `/` ↔ `/chat`

---

### Phase 11 — Headers + Service Worker
**Status:** ⬜ Not started

- `next.config.mjs`: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
- **COEP conflict resolution:** test if `r.jina.ai` fetch works with COEP. If not: create `/api/proxy?url=` thin passthrough route to call Jina from server (only route that remains).
- Service Worker for Gemma model caching (skip 1.5GB re-download on revisit)

---

## 8. Dependency Changes

### Add
```json
"idb": "^8.0.0"
```
(Check if `@xenova/transformers@2.17.2` supports Gemma 4 ONNX or upgrade to `@huggingface/transformers`)

### Remove from .env
```
OPENROUTER_API_KEY
OPENROUTER_MODEL
OPENROUTER_APP_TITLE
OPENROUTER_FALLBACK_MODEL
OPENROUTER_FALLBACK_MODELS
NEXT_PUBLIC_AUDIO_PROVIDER
NEXT_PUBLIC_ENABLE_LOCAL_TTS_FALLBACK
TTS_API_KEY
TTS_API_BASE_URL
```

### Keep in .env
```
TTS_MODEL=Xenova/mms-tts-eng
NEXT_PUBLIC_LOCAL_TTS_MODEL=Xenova/mms-tts-eng
```

---

## 9. Open Questions

1. **Transformers.js version:** Does `@xenova/transformers@2.17.2` support `onnx-community/gemma-4-E4B-it-ONNX` or does it require `@huggingface/transformers`? Verify before starting Phase 1.

2. **COEP + Jina conflict:** Test `Cross-Origin-Embedder-Policy: require-corp` with `fetch("https://r.jina.ai/...")`. May need `/api/proxy` as fallback.

3. **E4B vs E2B default:** Recommend starting with E2B (~500MB) as default, let user toggle to E4B in settings.

4. **Shared memory across `/` and `/chat`:** Both pages should share the same IndexedDB memory store. Design accordingly.

5. **texlyre-busytex 175MB assets:** Host on CDN or serve from Next.js `/public/`? Decision needed before Phase 6.

---

## 10. Reference Links

| Resource | URL |
|----------|-----|
| Gemma 4 docs | https://ai.google.dev/gemma/docs/core |
| Gemma 4 E4B ONNX | https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX |
| Gemma 4 WebGPU demo | https://huggingface.co/spaces/webml-community/Gemma-4-WebGPU |
| gemma-gem (browser agent) | https://github.com/kessler/gemma-gem |
| onyx (WebGPU demo) | https://github.com/sacredvoid/onyx |
| Agent-Reach | https://github.com/Panniantong/Agent-Reach |
| Jina Reader API | https://jina.ai/reader/ |
| Pyodide | https://pyodide.org |
| WebR | https://docs.r-wasm.org/webr/latest/ |
| DuckDB WASM | https://duckdb.org/docs/api/wasm |
| SwiftLaTeX | https://github.com/SwiftLaTeX/SwiftLaTeX |
| texlyre-busytex | https://github.com/TeXlyre/texlyre-busytex |
| Manim-web | https://maloyan.github.io/manim-web/ |
| MemPalace | https://github.com/MemPalace/mempalace |
| idb | https://github.com/jakearchibald/idb |

---

## 11. Terminal Log

*(Append verbatim terminal snippets as phases complete)*

```
[All phases pending]
```
