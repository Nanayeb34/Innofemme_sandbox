"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

interface Proposal {
  id: number;
  surface: string;
  summary: string;
  status: string;
  diff: string[];
}

const EXAMPLES = [
  "Add a warning screen on MTN when someone sends money to a number they have never paid before",
  "Hold transfers above GHS 500 to first-time recipients for 30 minutes",
  "Text customers when their SIM is swapped",
  "Require a second factor for any payment within 48 hours of a SIM swap",
  "Flag any wallet that receives money from 10 different people within an hour",
  "How are we doing so far, and what is costing us the most?",
];

export function Assistant({ team, onChange }: { team: string; onChange: () => void }) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [configured, setConfigured] = useState(true);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([
      api<{ configured: boolean; messages: { role: string; content: string }[] }>(team, "/assistant"),
      api<{ proposals: Proposal[] }>(team, "/proposals"),
    ]);
    setConfigured(a.configured);
    setMessages(a.messages);
    setProposals(p.proposals);
  }, [team]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the sandbox server
    load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, thinking]);

  const send = async (text: string) => {
    if (!text.trim() || thinking) return;
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setThinking(true);
    setError(null);
    try {
      await api(team, "/assistant", { body: { message: text } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
    }
  };

  const decide = async (id: number, action: "apply" | "discard") => {
    try {
      await api(team, `/proposals/${id}`, { body: { action } });
      await load();
      onChange();
    } catch (e) {
      setError((e as Error).message + ((e as { details?: string[] }).details ? `: ${(e as { details: string[] }).details.join("; ")}` : ""));
    }
  };

  const pending = proposals.filter((p) => p.status === "pending");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <section className="card flex min-h-[480px] flex-col">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {!configured && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              The AI assistant is not configured on this server yet. You can still change everything in the Controls tab or through the API.
            </div>
          )}
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                Tell the assistant, in plain language, how you want your mobile money system to behave. It prepares a change you can review before applying, and you can undo any change later.
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((e) => (
                  <button key={e} onClick={() => send(e)} className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100">
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${m.role === "user" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-900"}`}>{m.content}</div>
            </div>
          ))}
          {thinking && <div className="text-sm text-gray-500">Assistant is working on it…</div>}
          <div ref={endRef} />
        </div>
        {error && <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-2 border-t border-gray-200 p-3"
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Warn people before they approve a payment request" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900" />
          <button disabled={thinking || !input.trim()} className="btn btn-dark">
            Send
          </button>
        </form>
      </section>

      <aside className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Proposed changes</h3>
        {pending.length === 0 && <p className="text-sm text-gray-500">Nothing waiting. Proposals from the assistant appear here for you to review.</p>}
        {pending.map((p) => (
          <div key={p.id} className="card border-amber-300 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">{p.surface}</div>
            <div className="mt-1 text-sm font-medium text-gray-900">{p.summary}</div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-500">Show exact change ({p.diff.length})</summary>
              <pre className="mt-1 max-h-56 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-snug text-gray-700">{p.diff.join("\n")}</pre>
            </details>
            <div className="mt-3 flex gap-2">
              <button onClick={() => decide(p.id, "apply")} className="btn btn-dark">
                Apply
              </button>
              <button onClick={() => decide(p.id, "discard")} className="btn">
                Discard
              </button>
            </div>
          </div>
        ))}
        {proposals.filter((p) => p.status !== "pending").length > 0 && (
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">Earlier proposals</summary>
            <ul className="mt-1 space-y-1">
              {proposals
                .filter((p) => p.status !== "pending")
                .map((p) => (
                  <li key={p.id}>
                    <span className={p.status === "applied" ? "text-green-700" : "text-gray-400"}>{p.status}</span> · {p.summary}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </aside>
    </div>
  );
}
