"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * The conversation with the assistant. The same component fills the assistant's own page and the panel
 * that slides out beside any console. What the assistant does is shown as it happens: who is working,
 * each step and how it went, and anything it needs the person's say-so for.
 */

type Ev = { type: string } & Record<string, unknown>;

interface Status {
  enabled: boolean;
  chats: { id: string; title: string; updatedAt: string }[];
  usedToday: number;
  chat?: { id: string; title: string; busy: boolean; waiting: { id: string; summary: string }[]; events: Ev[] };
}

const EXAMPLES = [
  "Create two test customers on MTN and send GHS 20 from one to the other.",
  "Set up a mobile money agent on Telecel in Kumasi with GHS 5,000 of float.",
  "What is in my world right now?",
  "How does my application ask a customer for a payment?",
];

// ---------- what is on screen, worked out from the events ----------

interface StepRow {
  id: string;
  label: string;
  ok?: boolean;
  waiting?: boolean;
  summary?: string;
}
type Item =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "steps"; steps: StepRow[] }
  | { kind: "work"; agent: string; name: string; brief: string; steps: StepRow[]; notes: string[]; report?: string; done: boolean }
  | { kind: "confirm"; id: string; summary: string; answer?: "approved" | "declined" }
  | { kind: "notice"; text: string; bad?: boolean };

function arrange(events: Ev[]): Item[] {
  const items: Item[] = [];
  let work: Extract<Item, { kind: "work" }> | undefined;
  const rows = new Map<string, StepRow>();
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  for (const e of events) {
    if (e.type === "user") items.push({ kind: "user", text: s(e.text) });
    else if (e.type === "text") items.push({ kind: "text", text: s(e.text) });
    else if (e.type === "agent_start") {
      work = { kind: "work", agent: s(e.agent), name: s(e.name), brief: s(e.brief), steps: [], notes: [], done: false };
      items.push(work);
    } else if (e.type === "agent_end") {
      if (work) {
        work.done = true;
        work.report = s(e.report);
      }
      work = undefined;
    } else if (e.type === "note") work?.notes.push(s(e.text));
    else if (e.type === "tool") {
      const row: StepRow = { id: s(e.id), label: s(e.label) };
      rows.set(row.id, row);
      if (work && e.agent !== "lead") work.steps.push(row);
      else {
        const last = items[items.length - 1];
        if (last?.kind === "steps") last.steps.push(row);
        else items.push({ kind: "steps", steps: [row] });
      }
    } else if (e.type === "tool_result") {
      const row = rows.get(s(e.id));
      if (row) Object.assign(row, { ok: e.ok === true, waiting: e.waiting === true, summary: s(e.summary) });
    } else if (e.type === "confirm") items.push({ kind: "confirm", id: s(e.id), summary: s(e.summary) });
    else if (e.type === "approved" || e.type === "declined") {
      const c = items.find((i) => i.kind === "confirm" && i.id === e.id);
      if (c?.kind === "confirm") c.answer = e.type;
    } else if (e.type === "notice") items.push({ kind: "notice", text: s(e.text) });
    else if (e.type === "error") items.push({ kind: "notice", text: s(e.message), bad: true });
  }
  return items;
}

// ---------- the assistant's writing: paragraphs, lists, tables, bold, code ----------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-900">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function Prose({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={blocks.length} className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs leading-relaxed text-gray-100">
          {code.join("\n")}
        </pre>,
      );
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto">
          <table className="w-full text-left text-[0.92em]">
            <tbody>
              {rows.map((r, n) => (
                <tr key={n} className="border-b border-gray-200 align-top">
                  {r.map((c, m) => (n === 0 ? <th key={m} className="py-1 pr-3 font-semibold">{inline(c)}</th> : <td key={m} className="py-1 pr-3">{inline(c)}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) list.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={blocks.length} className={`space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {list.map((x, n) => (
            <li key={n}>{inline(x)}</li>
          ))}
        </L>,
      );
    } else if (/^#{1,4}\s+/.test(line)) {
      blocks.push(
        <p key={blocks.length} className="font-semibold text-gray-900">
          {inline(line.replace(/^#{1,4}\s+/, ""))}
        </p>,
      );
      i++;
    } else if (!line.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !lines[i].startsWith("```") && !/^\s*\|.*\|\s*$/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    }
  }
  return <div className="space-y-2">{blocks}</div>;
}

// ---------- pieces of the conversation ----------

function Steps({ steps, busy }: { steps: StepRow[]; busy: boolean }) {
  return (
    <ul className="space-y-1">
      {steps.map((r, n) => {
        const running = r.ok === undefined && busy && n === steps.length - 1;
        return (
          <li key={r.id + n} className="flex gap-2 text-xs leading-snug">
            <span className={`mt-0.5 w-3 shrink-0 text-center font-bold ${r.waiting ? "text-amber-600" : r.ok === false ? "text-red-600" : r.ok ? "text-green-700" : "text-gray-400"}`} aria-hidden>
              {r.waiting ? "?" : r.ok === false ? "×" : r.ok ? "✓" : running ? "…" : "·"}
            </span>
            <span className="min-w-0">
              <span className="text-gray-800">{r.label}</span>
              {r.summary && r.summary !== "Done" && <span className={`block break-words ${r.ok === false && !r.waiting ? "text-red-700" : "text-gray-500"}`}>{r.summary}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Work({ item, busy }: { item: Extract<Item, { kind: "work" }>; busy: boolean }) {
  return (
    <div className="rounded-xl border border-[#d9cdee] bg-[#f8f5fc] p-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-[#3b1f6e]">
        <span className="rounded-full bg-[#3b1f6e] px-2 py-0.5 text-[10px] uppercase tracking-wide text-white">{item.name}</span>
        <span className="font-normal text-gray-600">{item.done ? "finished" : busy ? "working…" : "stopped"}</span>
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs text-gray-600">What it was asked to do</summary>
        <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700">{item.brief}</p>
      </details>
      {item.steps.length > 0 && (
        <div className="mt-2">
          <Steps steps={item.steps} busy={busy && !item.done} />
        </div>
      )}
      {item.done && item.report && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-gray-600">Its report</summary>
          <div className="mt-1 text-xs text-gray-700">
            <Prose text={item.report} />
          </div>
        </details>
      )}
    </div>
  );
}

// ---------- the conversation ----------

export default function AssistantChat({ team, tall = false }: { team: string; tall?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const kept = `assistant:${team}`;

  const load = useCallback(
    async (id: string | null) => {
      try {
        const r = await fetch(`/api/w/${team}/assistant${id ? `?chat=${id}` : ""}`, { cache: "no-store" });
        const j = (await r.json()) as Status & { error?: string };
        if (!r.ok) {
          // A conversation that is gone: start from the list again.
          if (id) {
            localStorage.removeItem(kept);
            return load(null);
          }
          setProblem(j.error ?? "The assistant could not be reached.");
          return;
        }
        setProblem(null);
        setStatus(j);
        if (j.chat) {
          setChatId(j.chat.id);
          setEvents(j.chat.events);
        }
      } catch {
        setProblem("The assistant could not be reached.");
      }
    },
    [team, kept],
  );

  useEffect(() => {
    void load(localStorage.getItem(kept));
  }, [load, kept]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events, busy]);

  /** Says something to the assistant, or answers a request for approval, and shows the work as it comes back. */
  const send = useCallback(
    async (body: { text?: string; approve?: string; decline?: string }) => {
      if (busy) return;
      setBusy(true);
      setProblem(null);
      const control = new AbortController();
      stop.current = control;
      try {
        const res = await fetch(`/api/w/${team}/assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, chat: chatId ?? undefined }), signal: control.signal });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "The assistant could not be reached.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let waiting = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          waiting += decoder.decode(value, { stream: true });
          const parts = waiting.split("\n\n");
          waiting = parts.pop() ?? "";
          const fresh: Ev[] = [];
          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const e = JSON.parse(part.slice(6)) as Ev;
            if (e.type === "chat") {
              setChatId(String(e.id));
              localStorage.setItem(kept, String(e.id));
            } else fresh.push(e);
          }
          if (fresh.length) setEvents((all) => [...all, ...fresh]);
        }
      } catch (e) {
        if (!control.signal.aborted) setProblem((e as Error).message);
      } finally {
        setBusy(false);
        stop.current = null;
        void load(localStorage.getItem(kept));
      }
    },
    [busy, chatId, team, kept, load],
  );

  const say = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void send({ text: t });
  };

  const fresh = () => {
    if (busy) return;
    localStorage.removeItem(kept);
    setChatId(null);
    setEvents([]);
    setProblem(null);
  };

  const open = (id: string) => {
    if (busy || id === chatId) return;
    localStorage.setItem(kept, id);
    setEvents([]);
    void load(id);
  };

  const items = useMemo(() => arrange(events), [events]);
  const answered = new Set(items.flatMap((i) => (i.kind === "confirm" && i.answer ? [i.id] : [])));

  if (status && !status.enabled) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-gray-600">
        <div className="max-w-sm">
          <p className="font-semibold text-gray-900">The assistant is not switched on for this sandbox.</p>
          <p className="mt-1">It needs a key for an AI service, which the organisers add on the server. Everything else works as usual.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${tall ? "" : "h-full"}`}>
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <select
          className="min-w-0 flex-1 truncate rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs"
          value={chatId ?? ""}
          onChange={(e) => (e.target.value ? open(e.target.value) : fresh())}
          disabled={busy}
          aria-label="Conversation"
        >
          <option value="">New conversation</option>
          {status?.chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button className="btn !px-2.5 !py-1.5 !text-xs" onClick={fresh} disabled={busy || (!chatId && !events.length)}>
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm leading-relaxed text-gray-800">
        {items.length === 0 && (
          <div className="mx-auto max-w-md pt-4 text-center">
            <p className="font-semibold text-gray-900">Tell the assistant what you want done in your world.</p>
            <p className="mt-1 text-xs text-gray-600">
              It builds, tries things out, tests what you have built, finds things in the data and explains how the sandbox works. It works only in your team&apos;s world, and asks you first before anything that cannot be put back.
            </p>
            <div className="mt-4 grid gap-2 text-left">
              {EXAMPLES.map((x) => (
                <button key={x} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50" onClick={() => void send({ text: x })} disabled={busy || !status}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item, n) => {
          const isLast = n === items.length - 1;
          if (item.kind === "user")
            return (
              <div key={n} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[#3b1f6e] px-3 py-2 text-white">{item.text}</div>
              </div>
            );
          if (item.kind === "text")
            return (
              <div key={n} className="max-w-[95%] rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-3 py-2">
                <Prose text={item.text} />
              </div>
            );
          if (item.kind === "steps")
            return (
              <div key={n} className="pl-1">
                <Steps steps={item.steps} busy={busy && isLast} />
              </div>
            );
          if (item.kind === "work") return <Work key={n} item={item} busy={busy} />;
          if (item.kind === "confirm")
            return (
              <div key={n} className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-900">The assistant is asking first</div>
                <p className="mt-1 text-sm text-gray-900">{item.summary}</p>
                {item.answer ? (
                  <p className="mt-2 text-xs font-medium text-gray-600">{item.answer === "approved" ? "You approved this." : "You declined this."}</p>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-dark !py-1.5 !text-xs" disabled={busy || answered.has(item.id)} onClick={() => void send({ approve: item.id })}>
                      Approve
                    </button>
                    <button className="btn !py-1.5 !text-xs" disabled={busy || answered.has(item.id)} onClick={() => void send({ decline: item.id })}>
                      Decline
                    </button>
                  </div>
                )}
              </div>
            );
          return (
            <p key={n} className={`rounded-lg px-3 py-2 text-xs ${item.bad ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-700"}`}>
              {item.text}
            </p>
          );
        })}
        {busy && <p className="pl-1 text-xs text-gray-500">Working…</p>}
        {problem && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{problem}</p>}
        <div ref={end} />
      </div>

      <div className="border-t border-gray-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            className="max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-[#3b1f6e]"
            rows={2}
            placeholder="Say what you want done…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                say();
              }
            }}
          />
          {busy ? (
            <button className="btn btn-danger" onClick={() => stop.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn btn-dark" onClick={say} disabled={!text.trim() || !status}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
