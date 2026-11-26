"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, ChevronRight, History, Square, SquarePen, Trash2, X } from "lucide-react";
import { AssistantGlyph } from "./assistant-glyph";
import { askConfirm } from "@/stores/ui";

/**
 * The conversation with the assistant. The same component fills the assistant's own page (with a list of
 * conversations beside it) and the panel that slides out beside any console. The answer is shown word by word
 * as it is written, and the work as it happens: each step and how it went, the specialists at work, and
 * anything that needs the person's say-so.
 */

type Ev = { type: string } & Record<string, unknown>;

interface Status {
  enabled: boolean;
  provider: "anthropic" | "openai" | "demo" | null;
  chats: { id: string; title: string; updatedAt: string }[];
  usedToday: number;
  chat?: { id: string; title: string; busy: boolean; waiting: { id: string; summary: string }[]; events: Ev[] };
}

const EXAMPLES: [string, string][] = [
  ["Set up", "Create two test customers on MTN and send GHS 20 from one to the other."],
  ["Agents", "Set up a mobile money agent on Telecel in Kumasi with GHS 5,000 of float."],
  ["Look around", "What is in my world right now?"],
  ["Explain", "How does my application ask a customer for a payment?"],
];

const AGENT_LOOK: Record<string, string> = {
  builder: "bg-sky-100 text-sky-800",
  operator: "bg-emerald-100 text-emerald-800",
  integrator: "bg-amber-100 text-amber-800",
  analyst: "bg-violet-100 text-violet-800",
  guide: "bg-rose-100 text-rose-800",
};

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

// ---------- the assistant's writing: paragraphs, headings, lists, tables, bold, code ----------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-gray-900">
        {part.slice(2, -2)}
      </strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-900">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("_") && part.endsWith("_") && part.length > 2 ? (
      <em key={i} className="text-gray-500">
        {part.slice(1, -1)}
      </em>
    ) : (
      part
    ),
  );
}

function Prose({ text, live }: { text: string; live?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={blocks.length} className="overflow-x-auto rounded-xl bg-[#0b1120] p-4 font-mono text-[12.5px] leading-relaxed text-slate-100">
          {code.join("\n")}
        </pre>,
      );
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-left text-[0.92em]">
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, n) => (
                <tr key={n} className={n === 0 ? "bg-gray-50" : ""}>
                  {r.map((c, m) => (n === 0 ? <th key={m} className="px-3 py-2 font-semibold text-gray-900">{inline(c)}</th> : <td key={m} className="px-3 py-2">{inline(c)}</td>))}
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
        <L key={blocks.length} className={`space-y-1.5 pl-5 marker:text-gray-400 ${ordered ? "list-decimal" : "list-disc"}`}>
          {list.map((x, n) => (
            <li key={n} className="pl-1">
              {inline(x)}
            </li>
          ))}
        </L>,
      );
    } else if (/^#{1,4}\s+/.test(line)) {
      blocks.push(
        <p key={blocks.length} className="pt-1 font-semibold text-gray-900">
          {inline(line.replace(/^#{1,4}\s+/, ""))}
        </p>,
      );
      i++;
    } else if (!line.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !lines[i].startsWith("```") && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^#{1,4}\s+/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    }
  }
  return (
    <div className="space-y-3">
      {blocks}
      {live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-[#3b1f6e] align-[-2px]" aria-hidden />}
    </div>
  );
}

// ---------- small pieces ----------

function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} animate-spin text-[#3b1f6e]`} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Words that shimmer while something is under way. */
function Shimmer({ children }: { children: ReactNode }) {
  return <span className="shimmer-text">{children}</span>;
}

/** Shown only while the assistant is working, before any words or steps appear. */
function Thinking() {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <AssistantGlyph size={18} active className="rounded-[5px]" />
      <Shimmer>Thinking…</Shimmer>
    </div>
  );
}

function StepIcon({ row, running }: { row: StepRow; running: boolean }) {
  if (running) return <Spinner />;
  if (row.waiting) return <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-400 text-[9px] font-bold text-white">?</span>;
  if (row.ok === false)
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-rose-500 text-white">
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  if (row.ok)
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  return <span className="h-3.5 w-3.5 rounded-full border-2 border-gray-300" />;
}

/** The steps taken, as a compact list that can be folded away once they are done. */
function Steps({ steps, busy }: { steps: StepRow[]; busy: boolean }) {
  const running = busy && steps.some((r) => r.ok === undefined);
  const failed = steps.filter((r) => r.ok === false && !r.waiting).length;
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-gray-600 hover:text-gray-900">
        {running ? <Spinner /> : <StepIcon row={{ id: "", label: "", ok: failed === 0 }} running={false} />}
        <span className="flex-1">
          {running ? "Working" : failed ? `${steps.length} step${steps.length === 1 ? "" : "s"}, ${failed} did not work` : `${steps.length} step${steps.length === 1 ? "" : "s"} done`}
        </span>
        <ChevronDown aria-hidden className={`h-4 w-4 text-gray-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-gray-100 px-3 py-2.5">
          {steps.map((r, n) => (
            <li key={r.id + n} className="flex gap-2.5 text-[13px] leading-snug">
              <span className="mt-0.5">
                <StepIcon row={r} running={r.ok === undefined && busy} />
              </span>
              <span className="min-w-0">
                <span className={r.ok === undefined && busy ? "text-gray-900" : "text-gray-700"}>{r.label}</span>
                {r.summary && r.summary !== "Done" && <span className={`block break-words text-xs ${r.ok === false && !r.waiting ? "text-rose-700" : "text-gray-500"}`}>{r.summary}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A specialist at work: what it was asked, its steps, what it is writing now, and its report. */
function Work({ item, busy, live }: { item: Extract<Item, { kind: "work" }>; busy: boolean; live?: string }) {
  const working = busy && !item.done;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-2.5 border-b border-gray-100 bg-gray-50/70 px-3 py-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${AGENT_LOOK[item.agent] ?? "bg-gray-200 text-gray-700"}`}>{item.name.slice(0, 1).toUpperCase()}</span>
        <span className="text-[13px] font-semibold text-gray-900">{item.name}</span>
        <span className={`ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${working ? "bg-[#f3effa] text-[#3b1f6e]" : item.done ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
          {working && <Spinner className="h-3 w-3" />}
          {working ? "Working" : item.done ? "Done" : "Stopped"}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <details className="group text-xs">
          <summary className="cursor-pointer list-none text-gray-500 hover:text-gray-800">
            <ChevronRight className="inline h-3.5 w-3.5 transition group-open:rotate-90" /> What it was asked to do
          </summary>
          <p className="mt-1 whitespace-pre-wrap pl-3 text-gray-600">{item.brief}</p>
        </details>
        {item.steps.length > 0 && (
          <ul className="space-y-1.5">
            {item.steps.map((r, n) => (
              <li key={r.id + n} className="flex gap-2.5 text-[13px] leading-snug">
                <span className="mt-0.5">
                  <StepIcon row={r} running={r.ok === undefined && working} />
                </span>
                <span className="min-w-0">
                  <span className="text-gray-700">{r.label}</span>
                  {r.summary && r.summary !== "Done" && <span className={`block break-words text-xs ${r.ok === false && !r.waiting ? "text-rose-700" : "text-gray-500"}`}>{r.summary}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {working && live && <p className="border-l-2 border-[#3b1f6e]/30 pl-2.5 text-xs leading-5 text-gray-600">{live}</p>}
        {item.done && item.report && (
          <details className="group text-xs">
            <summary className="cursor-pointer list-none text-gray-500 hover:text-gray-800">
              <ChevronRight className="inline h-3.5 w-3.5 transition group-open:rotate-90" /> Its report
            </summary>
            <div className="mt-1.5 pl-3 text-[13px] text-gray-700">
              <Prose text={item.report} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

// ---------- the conversation ----------

export default function AssistantChat({ team, tall = false }: { team: string; tall?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // What is being written right now: by the assistant itself, and by each specialist at work.
  const [live, setLive] = useState("");
  const [liveAgents, setLiveAgents] = useState<Record<string, string>>({});
  const [history, setHistory] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const kept = `assistant:${team}`;

  const load = useCallback(
    async (id: string | null) => {
      try {
        const r = await fetch(`/api/w/${team}/assistant${id ? `?chat=${id}` : ""}`, { cache: "no-store" });
        const j = (await r.json()) as Status & { error?: string };
        if (!r.ok) {
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

  // Follow the conversation down as it grows, unless the person has scrolled up to read.
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, busy, live, liveAgents]);

  // The box grows with what is typed, up to a point.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  /** Says something to the assistant, or answers a request for approval, and shows the work as it comes back. */
  const send = useCallback(
    async (body: { text?: string; approve?: string; decline?: string }) => {
      if (busy) return;
      setBusy(true);
      setProblem(null);
      setLive("");
      setLiveAgents({});
      stick.current = true;
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
          let words = "";
          const agentWords: Record<string, string> = {};
          const clearAgents: string[] = [];
          let clearLead = false;
          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const e = JSON.parse(part.slice(6)) as Ev;
            if (e.type === "chat") {
              setChatId(String(e.id));
              localStorage.setItem(kept, String(e.id));
            } else if (e.type === "delta") {
              if (typeof e.agent === "string") agentWords[e.agent] = (agentWords[e.agent] ?? "") + String(e.text ?? "");
              else words += String(e.text ?? "");
            } else {
              fresh.push(e);
              if (e.type === "text") {
                clearLead = true;
                words = "";
              }
              if ((e.type === "tool" || e.type === "note" || e.type === "agent_end") && typeof e.agent === "string") clearAgents.push(e.agent);
              if (e.type === "tool" && e.agent === "lead") clearLead = true;
            }
          }
          if (fresh.length) setEvents((all) => [...all, ...fresh]);
          if (clearLead) setLive(words);
          else if (words) setLive((l) => l + words);
          if (clearAgents.length || Object.keys(agentWords).length)
            setLiveAgents((m) => {
              const next = { ...m };
              for (const a of clearAgents) delete next[a];
              for (const [a, w] of Object.entries(agentWords)) next[a] = (next[a] ?? "") + w;
              return next;
            });
        }
      } catch (e) {
        if (!control.signal.aborted) setProblem((e as Error).message);
      } finally {
        setBusy(false);
        setLive("");
        setLiveAgents({});
        stop.current = null;
        void load(localStorage.getItem(kept));
      }
    },
    [busy, chatId, team, kept, load],
  );

  const say = (t = text) => {
    const words = t.trim();
    if (!words || busy) return;
    setText("");
    void send({ text: words });
  };

  const fresh = () => {
    if (busy) return;
    localStorage.removeItem(kept);
    setChatId(null);
    setEvents([]);
    setProblem(null);
    setHistory(false);
    input.current?.focus();
  };

  const open = (id: string) => {
    setHistory(false);
    if (busy || id === chatId) return;
    localStorage.setItem(kept, id);
    setEvents([]);
    void load(id);
  };

  const remove = async (id: string) => {
    if (busy) return;
    const title = status?.chats.find((c) => c.id === id)?.title;
    if (!(await askConfirm({ title: "Delete this conversation?", message: title ? `"${title}" and everything in it will be removed.` : "It will be removed for good.", confirm: "Delete", danger: true }))) return;
    await fetch(`/api/w/${team}/assistant?chat=${id}`, { method: "DELETE" });
    if (id === chatId) fresh();
    void load(id === chatId ? null : chatId);
  };

  const items = useMemo(() => arrange(events), [events]);
  const answered = new Set(items.flatMap((i) => (i.kind === "confirm" && i.answer ? [i.id] : [])));
  const title = status?.chats.find((c) => c.id === chatId)?.title;
  const lastItem = items[items.length - 1];
  // While working and nothing is being written yet, show that it is thinking (unless a step already shows a spinner).
  const showThinking = busy && !live && !(lastItem?.kind === "steps" && lastItem.steps.some((r) => r.ok === undefined)) && !(lastItem?.kind === "work" && !lastItem.done);

  if (status && !status.enabled) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-gray-600">
        <div className="max-w-sm">
          <div className="mx-auto mb-3 w-fit">
            <AssistantGlyph size={40} className="rounded-xl" />
          </div>
          <p className="font-semibold text-gray-900">The assistant is not switched on for this sandbox.</p>
          <p className="mt-1">It needs a key for an AI service, which the organisers add on the server. To try it without one, start the server with ASSISTANT_PROVIDER=demo.</p>
        </div>
      </div>
    );
  }

  const conversations = (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={fresh} disabled={busy} className="mx-3 mt-3 mb-2 flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50 disabled:opacity-50">
        <SquarePen className="h-4 w-4" /> New conversation
      </button>
      <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Recent</div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {!status?.chats.length && <li className="px-3 py-2 text-xs text-gray-400">No conversations yet.</li>}
        {status?.chats.map((c) => (
          <li key={c.id} className="group relative">
            <button type="button" onClick={() => open(c.id)} className={`block w-full rounded-lg px-3 py-2 pr-8 text-left ${c.id === chatId ? "bg-[#f3effa] text-[#3b1f6e]" : "text-gray-700 hover:bg-gray-100"}`}>
              <span className="block truncate text-[13px] font-medium">{c.title}</span>
              <span className="block text-[11px] text-gray-400">{ago(c.updatedAt)}</span>
            </button>
            <button type="button" onClick={() => void remove(c.id)} aria-label={`Delete ${c.title}`} className="absolute top-2 right-1.5 hidden rounded-md px-1.5 py-0.5 text-xs text-gray-400 group-hover:block hover:bg-gray-200 hover:text-gray-700">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {status && <div className="border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-400">{status.usedToday} model call(s) today</div>}
    </div>
  );

  return (
    <div className={`flex min-h-0 flex-1 ${tall ? "" : "h-full flex-col"}`}>
      {/* The list of conversations: a column on the full page, a drop-down in the panel. */}
      {tall && <aside className="hidden w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50/70 md:flex">{conversations}</aside>}

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
          {!tall && (
            <button type="button" onClick={() => setHistory(!history)} className="rounded-lg px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100" aria-expanded={history}>
              <span className="flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> History</span>
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">{title ?? "New conversation"}</span>
          {status?.provider === "demo" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">Demo mode</span>}
          {tall && (
            <button type="button" onClick={fresh} disabled={busy || (!chatId && !events.length)} className="rounded-lg px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 md:hidden">
              <span className="flex items-center gap-1.5"><SquarePen className="h-3.5 w-3.5" /> New</span>
            </button>
          )}
          {!tall && (
            <button type="button" onClick={fresh} disabled={busy || (!chatId && !events.length)} className="rounded-lg px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40">
              <span className="flex items-center gap-1.5"><SquarePen className="h-3.5 w-3.5" /> New</span>
            </button>
          )}
        </div>
        {!tall && history && <div className="absolute inset-x-0 top-11 bottom-0 z-10 flex flex-col border-t border-gray-100 bg-white">{conversations}</div>}

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className={`mx-auto w-full space-y-4 px-4 py-6 text-[15px] leading-7 text-gray-800 ${tall ? "max-w-3xl" : ""}`}>
            {items.length === 0 && (
              <div className="pt-6 text-center sm:pt-14">
                <div className="mx-auto w-fit">
                  <AssistantGlyph size={44} active={busy} className="rounded-xl" />
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">What should we do in your world?</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">I can build, try things out, test what you have made, dig into the data, and explain how the sandbox works. I ask before anything that cannot be undone.</p>
                <div className={`mt-8 grid gap-3 text-left ${tall ? "sm:grid-cols-2" : ""}`}>
                  {EXAMPLES.map(([tag, x]) => (
                    <button key={x} type="button" className="group rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-[#3b1f6e]/40 hover:shadow" onClick={() => say(x)} disabled={busy || !status}>
                      <span className="block text-[11px] font-semibold tracking-wide text-[#3b1f6e] uppercase">{tag}</span>
                      <span className="mt-0.5 block text-sm leading-5 text-gray-700 group-hover:text-gray-900">{x}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((item, n) => {
              if (item.kind === "user")
                return (
                  <div key={n} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gray-100 px-4 py-2.5 whitespace-pre-wrap text-gray-900">{item.text}</div>
                  </div>
                );
              if (item.kind === "text") return <Prose key={n} text={item.text} />;
              if (item.kind === "steps") return <Steps key={n} steps={item.steps} busy={busy && n === items.length - 1} />;
              if (item.kind === "work") return <Work key={n} item={item} busy={busy} live={liveAgents[item.agent]} />;
              if (item.kind === "confirm")
                return (
                  <div key={n} className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-amber-900 uppercase">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] text-white">!</span>
                      Needs your approval
                    </div>
                    <p className="mt-1.5 text-sm text-gray-900">{item.summary}</p>
                    {item.answer ? (
                      <p className="mt-2 text-xs font-medium text-gray-600">{item.answer === "approved" ? "✓ You approved this." : "You declined this."}</p>
                    ) : (
                      <div className="mt-3 flex gap-2">
                        <button className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50" disabled={busy || answered.has(item.id)} onClick={() => void send({ approve: item.id })}>
                          Approve
                        </button>
                        <button className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50" disabled={busy || answered.has(item.id)} onClick={() => void send({ decline: item.id })}>
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                );
              return (
                <p key={n} className={`rounded-lg px-3 py-2 text-xs ${item.bad ? "bg-rose-50 text-rose-800" : "bg-gray-100 text-gray-600"}`}>
                  {item.text}
                </p>
              );
            })}

            {live && (
              <div className="flex gap-3">
                <AssistantGlyph size={24} active className="mt-0.5 rounded-[7px]" />
                <div className="min-w-0 flex-1">
                  <Prose text={live} live />
                </div>
              </div>
            )}
            {showThinking && <Thinking />}
            {problem && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{problem}</p>}
          </div>
        </div>

        <div className={`mx-auto w-full px-4 pb-4 ${tall ? "max-w-3xl" : ""}`}>
          <div className="rounded-2xl border border-gray-300 bg-white shadow-sm transition focus-within:border-[#3b1f6e] focus-within:ring-4 focus-within:ring-[#3b1f6e]/10">
            <textarea
              ref={input}
              className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400"
              rows={1}
              placeholder="Ask the assistant to do something in your world…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  say();
                }
              }}
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <span className="text-[11px] text-gray-400">Enter to send · Shift+Enter for a new line</span>
              {busy ? (
                <button type="button" onClick={() => stop.current?.abort()} className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-white hover:bg-gray-700" aria-label="Stop">
                  <Square className="h-3 w-3 fill-current" />
                </button>
              ) : (
                <button type="button" onClick={() => say()} disabled={!text.trim() || !status} className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-[#3b1f6e] text-white transition hover:bg-[#2e1757] disabled:bg-gray-200 disabled:text-gray-400" aria-label="Send">
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-gray-400">The assistant works only in your team&apos;s world, and can make mistakes. Check what it did on the consoles.</p>
        </div>
      </div>
    </div>
  );
}
