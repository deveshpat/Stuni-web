"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { agentLoop, gemma } from "@/lib/gemma";
import { memory } from "@/lib/memory";

type Msg = { id: string; role: "user" | "assistant"; content: string };

type ToolEvent = {
  id: string;
  name: string;
  args: string;
  result?: string;
};

function formatToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelState, setModelState] = useState("Not loaded");
  const [memoryContext, setMemoryContext] = useState("");
  const outputRef = useRef<HTMLDivElement | null>(null);

  const history = useMemo(
    () => messages.map((m) => ({ role: m.role, content: m.content })),
    [messages],
  );

  async function ensureLoaded() {
    if (modelState === "Ready") return;
    setModelState("Loading Gemma...");
    await gemma.load();
    const startup = await memory.getStartupContext();
    setMemoryContext(startup);
    setModelState("Ready");
  }

  async function onSend() {
    const text = input.trim();
    if (!text || loading) return;

    await ensureLoaded();
    setLoading(true);
    setInput("");

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    let assistantText = "";
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    const final = await agentLoop(text, {
      memoryContext,
      history,
      onToken: (token) => {
        assistantText += token;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: assistantText } : m)));
      },
      onToolCall: (name, args) => {
        const id = crypto.randomUUID();
        setToolEvents((prev) => [
          ...prev,
          {
            id,
            name,
            args: formatToolResult(args),
            result: "Running...",
          },
        ]);
      },
      onToolResult: (name, result) => {
        const id = crypto.randomUUID();
        setToolEvents((prev) => [
          ...prev,
          {
            id,
            name,
            args: "agent_loop",
            result: formatToolResult(result),
          },
        ]);
      },
    });

    setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: final || assistantText } : m)));
    await memory.store({ wing: "video", room: "chat", content: `User: ${text}\nAssistant: ${final}`, timestamp: Date.now() });
    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-8">
      <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-[1fr_300px] gap-4">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <header className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-semibold">stuni chat</h1>
            <div className="flex items-center gap-3 text-xs text-zinc-400">
              <span>{modelState}</span>
              <Link className="underline" href="/">Back to video</Link>
            </div>
          </header>

          <div className="h-[60vh] overflow-y-auto space-y-3 pr-1">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${msg.role === "user" ? "bg-emerald-700" : "bg-zinc-800"}`}>
                  {msg.content || (msg.role === "assistant" ? "..." : "")}
                </div>
              </div>
            ))}
            {toolEvents.map((tool) => (
              <details key={tool.id} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-zinc-300">{tool.name}({tool.args.slice(0, 90)})</summary>
                <div className="mt-2 whitespace-pre-wrap text-zinc-400">{tool.result || "Running..."}</div>
              </details>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              className="flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              placeholder="Ask anything, or request Python/SQL/LaTeX/3D animation..."
            />
            <button
              type="button"
              onClick={onSend}
              disabled={loading}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Send
            </button>
          </div>

          <div
            id="js-sandbox-host"
            ref={outputRef}
            className="mt-4 rounded-lg border border-zinc-800 overflow-hidden"
          />
        </section>

        <aside className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <h2 className="text-sm font-semibold mb-2">Memory Browser</h2>
          <p className="text-xs text-zinc-400 whitespace-pre-wrap">{memoryContext || "Memory loads after model init."}</p>
        </aside>
      </div>
    </main>
  );
}
