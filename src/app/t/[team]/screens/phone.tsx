"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TelcoMark } from "@/components/telco-mark";
import { Loading, useView } from "@/components/ui";
import { api, ghs, teamName, when } from "@/lib/client";
import { CallLog, CallScreen, useCalls, type CallLogRow, type Calls } from "./calls";
import { Select } from "@/components/select";
import { askConfirm } from "@/stores/ui";

interface Line {
  msisdn: string;
  telco: string;
  status: string;
  owner: string;
  label: string;
  kind: string;
}
interface PhoneState {
  msisdn: string;
  telco: string;
  brand: { name: string; wallet: string; color: string };
  logo: string | null;
  simStatus: string;
  owner: string;
  shortcode: string;
  approvalsPath: string;
  codes: { code: string; label: string }[];
  wallet: { name: string; type: string; tier: string; status: string; balance: number } | null;
  sms: { id: number; sender: string; body: string; at: string }[];
  approvals: { ref: string; kind: string; amount: number; from: string }[];
  calls: CallLogRow[];
  conversations: { with: string; canReply: boolean; lastBody: string; lastAt: string; lastOut: boolean; count: number }[];
  contacts: { number: string; name: string }[];
  thread: { with: string; canReply: boolean; messages: { id: string; at: string; out: boolean; body: string; failed: string | null; warning: string | null }[] } | null;
  recent: { id: string; at: string; type: string; amount: number; status: string; from: string; to: string; out: boolean }[];
}
interface PhoneView {
  lines: Line[];
  /** How many more phones exist than the list shows. */
  more?: number;
  /** The number this answer is about. */
  asked?: string;
  phone: PhoneState | null;
}

type Tab = "dial" | "calls" | "sms" | "contacts" | "wallet";
const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };
const NETWORK: Record<string, string> = { mtn: "MTN", telecel: "Telecel", at: "AT" };

export default function Phone({ team, role }: { team: string; role: string }) {
  const [msisdn, setMsisdn] = useState("");
  // The conversation open on the Messages tab: a number, or a sender name such as MTNMoMo.
  const [thread, setThread] = useState("");
  const { data, error, refresh } = useView<PhoneView>(team, `/s/phone?msisdn=${msisdn}&thread=${encodeURIComponent(thread)}`, 2500);
  const [tab, setTab] = useState<Tab>("dial");
  const [seen, setSeen] = useState<Record<string, number>>({});

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's saved choice once
      setMsisdn(localStorage.getItem(`phone:${team}`) ?? "");
    } catch {}
  }, [team]);

  const lines = data?.lines ?? [];
  // Fall back to the first line when nothing (or a line that does not exist) is chosen. A number that is not in the
  // list yet is kept until the server has answered about it: the list shows only the most recent phones.
  const current = !data || data.asked !== msisdn || lines.some((l) => l.msisdn === msisdn) ? msisdn : (lines[0]?.msisdn ?? "");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the list of lines loaded from the server
    if (current !== msisdn) setMsisdn(current);
  }, [current, msisdn]);

  const pick = (m: string) => {
    setMsisdn(m);
    setThread("");
    setTab("dial");
    try {
      localStorage.setItem(`phone:${team}`, m);
    } catch {}
  };

  const state = data?.phone?.msisdn === current ? data.phone : null;
  const lastSeen = seen[current];
  const newest = state?.sms[0]?.id ?? 0;
  // The first time a line is opened, everything already in its inbox counts as read.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks messages read when the inbox is on screen
    if (state && (lastSeen === undefined || tab === "sms") && lastSeen !== newest) setSeen((s) => ({ ...s, [current]: newest }));
  }, [state, lastSeen, newest, tab, current]);
  const unread = state && lastSeen !== undefined ? state.sms.filter((s) => s.id > lastSeen).length : 0;
  const [calls, voiceRef] = useCalls(team, state?.simStatus === "active" ? current : "");
  // Missed calls show a badge until the call log has been opened.
  const [seenCalls, setSeenCalls] = useState<Record<string, string>>({});
  const newestCall = state?.calls[0]?.id ?? "";
  const lastSeenCall = seenCalls[current];
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks calls seen when the call log is on screen
    if (state && (lastSeenCall === undefined || tab === "calls") && lastSeenCall !== newestCall) setSeenCalls((s) => ({ ...s, [current]: newestCall }));
  }, [state, lastSeenCall, newestCall, tab, current]);
  const seenAt = state?.calls.findIndex((c) => c.id === lastSeenCall) ?? -1;
  const missed = state && lastSeenCall !== undefined ? state.calls.slice(0, seenAt < 0 ? state.calls.length : seenAt).filter((c) => c.direction === "missed").length : 0;
  const brandColor = state?.brand.color ?? "#334155";
  // Saved names for numbers, so messages and calls show "Ama" instead of 0241234567.
  const names = Object.fromEntries((state?.contacts ?? []).map((c) => [c.number, c.name]));
  // A number to save, when "Add to contacts" is pressed somewhere else on the phone.
  const [draft, setDraft] = useState<string | null>(null);
  const saveNumber = (n: string) => {
    setDraft(n);
    setTab("contacts");
  };

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        {role === "team" && (
          <Link href={`/t/${team}`} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
            ← All systems
          </Link>
        )}
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{teamName(team)} · Phone</div>
        {role !== "team" && (
          <Link href={`/t/${team}/console`} className="text-xs text-gray-500 underline">
            Use this device for the consoles
          </Link>
        )}
      </div>

      {!data ? (
        <Loading error={error} />
      ) : lines.length === 0 ? (
        <div className="card p-5 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">There are no phones yet.</p>
          <p className="mt-1">A phone appears here once someone has a registered SIM card.</p>
          {role !== "team" && <p className="mt-2">Ask your team to register a SIM for you, then come back to this page.</p>}
          <ol className={`mt-2 list-decimal space-y-1 pl-5 ${role === "team" ? "" : "hidden"}`}>
            <li>
              <Link className="underline" href={`/t/${team}/nia`}>
                NIA
              </Link>{" "}
              issues the person a Ghana Card.
            </li>
            <li>
              A{" "}
              <Link className="underline" href={`/t/${team}/sim-agent/mtn`}>
                SIM registration point
              </Link>{" "}
              registers a SIM for them. Each network&apos;s head office can do this straight away.
            </li>
          </ol>
        </div>
      ) : (
        <>
          <div className="mb-3 block text-sm">
            <span className="text-xs font-medium text-gray-600">Whose phone is this?</span>
            <Select
              className="mt-1"
              value={current}
              onChange={pick}
              searchable={lines.length > 5}
              label="Whose phone is this?"
              options={lines.map((l) => ({ value: l.msisdn, label: `${l.label}${l.status !== "active" ? " (blocked)" : ""}`, hint: `${l.msisdn} · ${NETWORK[l.telco]}` }))}
            />
            {!!data?.more && <OtherNumber more={data.more} onPick={pick} />}
          </div>

          <div className="flex min-h-[620px] flex-1 flex-col overflow-hidden rounded-[2rem] border-[6px] border-gray-900 bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-2 text-xs font-semibold" style={{ background: brandColor, color: TEXT_ON[state?.telco ?? ""] ?? "#fff" }}>
              <span>{state ? (state.simStatus === "active" ? `${state.brand.name} GH` : "No service") : "…"}</span>
              <span>{when(new Date().toISOString(), false)}</span>
              <span>{state?.simStatus === "active" ? "▮▮▮ 4G" : "✕"}</span>
            </div>

            <div className="relative flex-1 overflow-y-auto">
              <audio ref={voiceRef} autoPlay playsInline className="hidden" />
              <CallScreen calls={calls} />
              {!state ? (
                <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
              ) : tab === "dial" ? (
                <Dialer key={state.msisdn} team={team} state={state} calls={calls} onDone={refresh} />
              ) : tab === "calls" ? (
                <CallLog rows={state.calls} calls={calls} names={names} onCall={(n) => void calls.start(n)} />
              ) : tab === "sms" ? (
                <Messages key={state.msisdn} team={team} state={state} names={names} thread={thread} setThread={setThread} onSent={refresh} onSave={saveNumber} />
              ) : tab === "contacts" ? (
                <Contacts
                  key={state.msisdn}
                  team={team}
                  state={state}
                  draft={draft}
                  clearDraft={() => setDraft(null)}
                  onChange={refresh}
                  onCall={(n) => void calls.start(n)}
                  onText={(n) => {
                    setThread(n);
                    setTab("sms");
                  }}
                />
              ) : (
                <Wallet state={state} />
              )}
            </div>

            <nav className="grid grid-cols-5 border-t border-gray-200 bg-gray-50 text-[11px]">
              {(
                [
                  ["dial", "Phone", "☎"],
                  ["calls", "Calls", "↙"],
                  ["sms", "Messages", "✉"],
                  ["contacts", "Contacts", "☺"],
                  ["wallet", "Wallet", "₵"],
                ] as [Tab, string, string][]
              ).map(([key, label, icon]) => (
                <button key={key} onClick={() => setTab(key)} className={`relative flex flex-col items-center gap-0.5 py-2 ${tab === key ? "font-semibold text-gray-900" : "text-gray-500"}`}>
                  <span className="text-base leading-none">{icon}</span>
                  {label}
                  {key === "calls" && missed > 0 && tab !== "calls" && <span className="absolute right-[22%] top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">{missed > 9 ? "9+" : missed}</span>}
                  {key === "sms" && unread > 0 && tab !== "sms" && <span className="absolute right-[22%] top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">{unread > 9 ? "9+" : unread}</span>}
                  {key === "dial" && state && state.approvals.length > 0 && <span className="absolute right-[22%] top-1 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] font-bold leading-4 text-white">{state.approvals.length}</span>}
                </button>
              ))}
            </nav>
          </div>

          {state && (
            <p className="mt-3 text-center text-xs text-gray-500">
              {state.owner} · {state.msisdn} · {state.wallet ? `${state.brand.wallet} wallet, ${state.wallet.tier} KYC` : `no ${state.brand.wallet} wallet yet`}
            </p>
          )}
        </>
      )}
    </main>
  );
}

function Dialer({ team, state, calls, onDone }: { team: string; state: PhoneState; calls: Calls; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [session, setSession] = useState<{ id: string; text: string; end: boolean } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (session && !session.end) inputRef.current?.focus();
  }, [session]);

  const send = async (text: string, sessionId?: string) => {
    setBusy(true);
    try {
      const r = await api<{ sessionId: string; text: string; end: boolean }>(team, "/s/phone", { body: { action: "ussd", msisdn: state.msisdn, input: text, sessionId } });
      setSession({ id: r.sessionId, text: r.text, end: r.end });
      setInput("");
      onDone();
    } catch (e) {
      setSession({ id: "", text: (e as Error).message, end: true });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setSession(null);
    setCode("");
  };

  if (session) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 p-5">
        <div className="w-full rounded-xl bg-white p-4 shadow-lg">
          <p className="ussd-text text-[15px] leading-snug text-gray-900">{session.text}</p>
          {session.end ? (
            <button onClick={close} className="mt-4 w-full rounded-lg bg-gray-900 py-2 text-sm font-medium text-white">
              OK
            </button>
          ) : (
            <form
              className="mt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (input) void send(input, session.id);
              }}
            >
              <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} className="w-full border-b-2 border-gray-400 py-1 text-base outline-none focus:border-gray-900" aria-label="USSD reply" autoComplete="off" />
              <div className="mt-3 flex justify-end gap-4 text-sm font-semibold">
                <button type="button" onClick={close} className="text-gray-500">
                  Cancel
                </button>
                <button disabled={busy || !input} className="text-blue-700 disabled:opacity-40">
                  {busy ? "…" : "Send"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // A code ending in # is a USSD request; anything else is a number to call.
  const isCode = code.endsWith("#") || code.startsWith("*");
  const canDial = code.endsWith("#") || (!isCode && code.length >= 3);
  const dial = () => {
    if (code.endsWith("#")) return void send(code);
    void calls.start(code);
    setCode("");
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  return (
    <div className="flex h-full flex-col px-6 pb-5 pt-4">
      {state.approvals.length > 0 && (
        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {state.approvals.length} payment request(s) waiting. Dial {state.shortcode} and {state.approvalsPath} to approve or reject.
        </div>
      )}
      <div className="flex min-h-12 items-center justify-center text-3xl tracking-wider text-gray-900">{code || <span className="text-base text-gray-400">Dial a number or a short code</span>}</div>
      <div className="mb-3 flex flex-wrap justify-center gap-1.5">
        {state.codes.map((c) => (
          <button key={c.code} onClick={() => setCode(c.code)} className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] text-gray-700" title={c.label}>
            {c.code} <span className="text-gray-400">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="mx-auto grid w-full max-w-[260px] grid-cols-3 gap-3">
        {keys.map((k) => (
          <button key={k} onClick={() => setCode((c) => (c + k).slice(0, 20))} className="flex h-14 items-center justify-center rounded-full bg-gray-100 text-xl font-medium text-gray-900 active:bg-gray-200">
            {k}
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-center gap-6">
        <span className="w-12" />
        <button onClick={dial} disabled={busy || !canDial} className="flex h-16 w-16 items-center justify-center rounded-full bg-green-600 text-2xl text-white shadow active:bg-green-700 disabled:opacity-40" aria-label="Call">
          ✆
        </button>
        <button onClick={() => setCode((c) => c.slice(0, -1))} className="w-12 text-xl text-gray-500" aria-label="Delete">
          ⌫
        </button>
      </div>
    </div>
  );
}

const SMS_LIMIT = 480;
const smsParts = (text: string) => Math.max(1, Math.ceil(text.length / 160));

/** The Messages app: conversations, one open thread, and writing a new text. */
function Messages({ team, state, names, thread, setThread, onSent, onSave }: { team: string; state: PhoneState; names: Record<string, string>; thread: string; setThread: (t: string) => void; onSent: () => void; onSave: (number: string) => void }) {
  const [composing, setComposing] = useState(false);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const open = state.thread && state.thread.with === thread ? state.thread : null;
  const count = open?.messages.length ?? 0;

  // Keep the newest message in view.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, thread]);

  const send = async (number: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ to: string; delivered: boolean; reason?: string }>(team, "/s/phone", { body: { action: "sms_send", msisdn: state.msisdn, to: number, text } });
      setText("");
      setTo("");
      setComposing(false);
      setThread(r.to);
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = (number: string, placeholder: string) => (
    <form
      className="border-t border-gray-200 bg-white p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send(number);
      }}
    >
      {error && <p className="mb-1 px-1 text-xs text-red-600">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, SMS_LIMIT))} rows={2} placeholder={placeholder} aria-label="Message" className="min-w-0 flex-1 resize-none rounded-2xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900" />
        <button disabled={busy || !text.trim() || !number} className="rounded-full bg-green-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {busy ? "…" : "Send"}
        </button>
      </div>
      <p className="mt-1 px-1 text-[10px] text-gray-400">
        {text.length}/{SMS_LIMIT} · {smsParts(text)} message{smsParts(text) > 1 ? "s" : ""}
      </p>
    </form>
  );

  if (composing) {
    return (
      <div className="absolute inset-0 flex flex-col bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <button onClick={() => setComposing(false)} className="text-sm text-blue-700" aria-label="Back to messages">
            ‹ Messages
          </button>
          <span className="text-sm font-semibold text-gray-900">New message</span>
        </div>
        <label className="block border-b border-gray-100 px-4 py-3 text-sm">
          <span className="text-xs text-gray-500">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" placeholder="Name or mobile number" aria-label="Send to" className="mt-0.5 w-full border-b border-gray-300 py-1 text-base outline-none focus:border-gray-900" />
        </label>
        {/* Pick someone from the contacts, as on a real phone. */}
        <ul className="flex-1 divide-y divide-gray-100 overflow-y-auto">
          {state.contacts
            .filter((c) => !to.trim() || c.name.toLowerCase().includes(to.trim().toLowerCase()) || c.number.includes(to.replace(/\D/g, "")))
            .map((c) => (
              <li key={c.number}>
                <button type="button" onClick={() => setTo(c.number)} className={`flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gray-50 ${to === c.number ? "bg-green-50" : ""}`}>
                  <Avatar name={c.name} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-gray-900">{c.name}</span>
                    <span className="block text-[11px] text-gray-500">{c.number}</span>
                  </span>
                </button>
              </li>
            ))}
        </ul>
        {box(state.contacts.find((c) => c.name.toLowerCase() === to.trim().toLowerCase())?.number ?? to.trim(), "Write a message")}
      </div>
    );
  }

  if (thread) {
    return (
      <div className="absolute inset-0 flex flex-col bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <button onClick={() => setThread("")} className="text-sm text-blue-700" aria-label="Back to messages">
            ‹ Messages
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
            {names[thread] ?? thread}
            {names[thread] && <span className="ml-1.5 text-xs font-normal text-gray-500">{thread}</span>}
          </span>
          {open?.canReply && !names[thread] && (
            <button onClick={() => onSave(thread)} className="shrink-0 text-xs text-blue-700">
              Add to contacts
            </button>
          )}
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto bg-gray-50 px-3 py-3">
          {!open ? (
            <p className="text-center text-sm text-gray-400">Loading…</p>
          ) : (
            open.messages.map((m) => (
              <div key={m.id} className={`flex ${m.out ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug ${m.out ? (m.failed ? "bg-red-100 text-red-900" : "bg-green-600 text-white") : "bg-white text-gray-900 shadow-sm"}`}>
                  {m.warning && <p className="mb-1 rounded bg-amber-100 px-1.5 py-1 text-[11px] font-medium text-amber-900">⚠ {m.warning}</p>}
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`mt-0.5 text-[10px] ${m.out && !m.failed ? "text-green-100" : "text-gray-400"}`}>
                    {when(m.at)}
                    {m.failed ? ` · Not delivered: ${m.failed}` : ""}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={bottom} />
        </div>
        {open && (open.canReply ? box(thread, "Reply") : <p className="border-t border-gray-200 bg-white px-4 py-3 text-center text-xs text-gray-500">You cannot reply to this sender.</p>)}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <span className="text-sm font-semibold text-gray-900">Messages</span>
        <button onClick={() => { setError(null); setComposing(true); }} className="rounded-full bg-green-600 px-3 py-1 text-xs font-semibold text-white">
          New message
        </button>
      </div>
      {state.conversations.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">No messages yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {state.conversations.map((c) => (
            <li key={c.with}>
              <button onClick={() => { setError(null); setThread(c.with); }} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-900">{names[c.with] ?? c.with}</span>
                  <span className="shrink-0 text-[11px] text-gray-400">{when(c.lastAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-gray-600">
                  {c.lastOut ? "You: " : ""}
                  {c.lastBody}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
// A steady colour per name, so the same person always looks the same.
const AVATAR_COLORS = ["#3b1f6e", "#0f766e", "#b45309", "#be123c", "#1d4ed8", "#4d7c0f", "#7e22ce", "#0369a1"];
const colorOf = (name: string) => AVATAR_COLORS[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${dims}`} style={{ background: colorOf(name) }} aria-hidden>
      {initials(name) || "?"}
    </span>
  );
}

/**
 * The Contacts app: an A to Z list to scroll or search, a page per contact (call, text, edit, delete), and a form
 * to add someone. Contacts are kept on this phone only.
 */
function Contacts({ team, state, draft, clearDraft, onChange, onCall, onText }: { team: string; state: PhoneState; draft: string | null; clearDraft: () => void; onChange: () => void; onCall: (n: string) => void; onText: (n: string) => void }) {
  const [query, setQuery] = useState("");
  const [openNumber, setOpenNumber] = useState<string | null>(null);
  // The form: null when closed; "was" is the number being edited, if any.
  const [form, setForm] = useState<{ name: string; number: string; was?: string } | null>(draft ? { name: "", number: draft } : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (draft) clearDraft();
  }, [draft, clearDraft]);

  const save = async () => {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ number: string }>(team, "/s/phone", { body: { action: "contact_save", msisdn: state.msisdn, name: form.name, number: form.number, was: form.was } });
      setForm(null);
      setOpenNumber(r.number);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: { number: string; name: string }) => {
    if (!(await askConfirm({ title: `Delete ${c.name}?`, message: `${c.number} will be removed from this phone's contacts.`, confirm: "Delete", danger: true }))) return;
    await api(team, "/s/phone", { body: { action: "contact_remove", msisdn: state.msisdn, number: c.number } });
    setOpenNumber(null);
    onChange();
  };

  const header = (title: string, back?: () => void, right?: React.ReactNode) => (
    <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
      {back && (
        <button onClick={back} className="text-sm text-blue-700">
          ‹ Contacts
        </button>
      )}
      <span className="flex-1 truncate text-sm font-semibold text-gray-900">{title}</span>
      {right}
    </div>
  );

  if (form) {
    const field = (label: string, key: "name" | "number", props: React.InputHTMLAttributes<HTMLInputElement>) => (
      <label className="block border-b border-gray-100 px-4 py-3 text-sm">
        <span className="text-xs text-gray-500">{label}</span>
        <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="mt-0.5 w-full border-b border-gray-300 py-1 text-base outline-none focus:border-gray-900" {...props} />
      </label>
    );
    return (
      <div className="absolute inset-0 flex flex-col bg-white">
        {header(form.was ? "Edit contact" : "New contact", () => setForm(null))}
        <form
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex justify-center py-5">
            <Avatar name={form.name || "?"} size="lg" />
          </div>
          {field("Name", "name", { autoFocus: !form.name, placeholder: "Ama Mensah", "aria-label": "Contact name", maxLength: 40 })}
          {field("Mobile number", "number", { inputMode: "tel", placeholder: "024 123 4567", "aria-label": "Contact number" })}
          {error && <p className="px-4 pt-2 text-xs text-red-600">{error}</p>}
          <div className="mt-auto p-4">
            <button disabled={busy || !form.name.trim() || !form.number.trim()} className="w-full rounded-full bg-green-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  const opened = state.contacts.find((c) => c.number === openNumber);
  if (opened) {
    const action = (label: string, icon: string, onClick: () => void, color = "text-green-700") => (
      <button onClick={onClick} className="flex flex-1 flex-col items-center gap-1 rounded-xl bg-gray-50 py-3 text-xs text-gray-700 hover:bg-gray-100">
        <span className={`text-xl leading-none ${color}`}>{icon}</span>
        {label}
      </button>
    );
    return (
      <div className="absolute inset-0 flex flex-col bg-white">
        {header("", () => setOpenNumber(null), <button onClick={() => setForm({ name: opened.name, number: opened.number, was: opened.number })} className="text-sm text-blue-700">Edit</button>)}
        <div className="flex flex-col items-center px-4 pt-6 pb-4 text-center">
          <Avatar name={opened.name} size="lg" />
          <div className="mt-3 text-xl font-semibold text-gray-900">{opened.name}</div>
          <div className="text-sm text-gray-500">{opened.number}</div>
        </div>
        <div className="flex gap-2 px-4">
          {action("Call", "✆", () => onCall(opened.number))}
          {action("Message", "✉", () => onText(opened.number), "text-blue-700")}
        </div>
        <div className="mt-auto p-4">
          <button onClick={() => void remove(opened)} className="w-full rounded-full border border-red-200 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
            Delete contact
          </button>
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const digits = query.replace(/\D/g, "");
  const shown = state.contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || (digits && c.number.includes(digits)));
  // Grouped under their first letter, A to Z, as phones do.
  const groups = new Map<string, typeof shown>();
  for (const c of shown) {
    const letter = /[a-z]/i.test(c.name[0] ?? "") ? c.name[0]!.toUpperCase() : "#";
    groups.set(letter, [...(groups.get(letter) ?? []), c]);
  }
  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-lg font-semibold text-gray-900">Contacts</span>
        <button
          onClick={() => {
            setError(null);
            setForm({ name: "", number: digits.length >= 9 ? query : "" });
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-green-600 text-lg leading-none text-white"
          aria-label="Add a contact"
        >
          +
        </button>
      </div>
      <div className="px-4 pb-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${state.contacts.length} contact${state.contacts.length === 1 ? "" : "s"}`} aria-label="Search contacts" className="w-full rounded-full bg-gray-100 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-300" />
      </div>
      <div className="flex-1 overflow-y-auto">
        {state.contacts.length === 0 ? (
          <div className="px-6 pt-10 text-center text-sm text-gray-500">
            <p>No contacts yet.</p>
            <button onClick={() => setForm({ name: "", number: "" })} className="mt-3 rounded-full bg-green-600 px-4 py-2 text-xs font-semibold text-white">
              Add a contact
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-6 pt-8 text-center text-sm text-gray-500">No contact matches “{query}”.</p>
        ) : (
          [...groups].map(([letter, people]) => (
            <section key={letter}>
              <h3 className="sticky top-0 z-10 bg-gray-50/95 px-4 py-1 text-xs font-semibold text-gray-500 backdrop-blur">{letter}</h3>
              <ul>
                {people.map((c) => (
                  <li key={c.number}>
                    <button onClick={() => setOpenNumber(c.number)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gray-50">
                      <Avatar name={c.name} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-gray-900">{c.name}</span>
                        <span className="block text-xs text-gray-500">{c.number}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Wallet({ state }: { state: PhoneState }) {
  if (!state.wallet) {
    return (
      <div className="p-6 text-center text-sm text-gray-600">
        <TelcoMark telco={state.telco} logo={state.logo} height={36} />
        <p className="mt-3">
          This number has no {state.brand.wallet} wallet. Dial {state.shortcode} to register, or visit a mobile money agent with your Ghana Card.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="px-5 py-5 text-center" style={{ background: state.brand.color, color: TEXT_ON[state.telco] }}>
        <div className="text-xs font-semibold uppercase tracking-wide opacity-80">{state.brand.wallet}</div>
        <div className="mt-1 text-3xl font-semibold">{ghs(state.wallet.balance)}</div>
        <div className="mt-1 text-xs opacity-80">
          {state.wallet.name} · {state.wallet.tier} KYC{state.wallet.status !== "active" ? ` · ${state.wallet.status}` : ""}
        </div>
      </div>
      <p className="px-4 pt-3 text-[11px] text-gray-500">To send money, pay or cash out, dial {state.shortcode} on the Phone tab.</p>
      <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Recent</h3>
      {state.recent.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-gray-500">No transactions yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {state.recent.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate text-gray-900">{t.out ? t.to : t.from || "Cash"}</div>
                <div className="text-[11px] text-gray-500">
                  {when(t.at)} · {t.type.replace(/_/g, " ")}
                  {t.status !== "success" ? ` · ${t.status}` : ""}
                </div>
              </div>
              <div className={`shrink-0 font-medium tabular-nums ${t.out ? "text-gray-900" : "text-green-700"}`}>
                {t.out ? "−" : "+"}
                {ghs(t.amount)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The list shows the most recently registered phones. Any other phone is opened by typing its number. */
function OtherNumber({ more, onPick }: { more: number; onPick: (msisdn: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <span className="mt-1 flex items-center gap-2 text-xs text-gray-500">
      <span className="shrink-0">+{more.toLocaleString("en")} more.</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" placeholder="Type any number to open it" aria-label="Open another number" className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs" />
      <button
        type="button"
        className="rounded border border-gray-300 px-2 py-1 text-xs"
        onClick={(e) => {
          e.preventDefault();
          const digits = value.replace(/\D/g, "");
          if (digits.length >= 9) onPick(digits.length === 9 ? `0${digits}` : digits.startsWith("233") ? `0${digits.slice(3)}` : digits);
        }}
      >
        Open
      </button>
    </span>
  );
}
