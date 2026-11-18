"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TelcoMark } from "@/components/telco-mark";
import { Loading, useView } from "@/components/ui";
import { api, ghs, teamName, when } from "@/lib/client";
import { CallLog, CallScreen, useCalls, type CallLogRow, type Calls } from "./calls";

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
  codes: { code: string; label: string }[];
  wallet: { name: string; type: string; tier: string; status: string; balance: number } | null;
  sms: { id: number; sender: string; body: string; at: string }[];
  approvals: { ref: string; kind: string; amount: number; from: string }[];
  calls: CallLogRow[];
  recent: { id: string; at: string; type: string; amount: number; status: string; from: string; to: string; out: boolean }[];
}
interface PhoneView {
  lines: Line[];
  phone: PhoneState | null;
}

type Tab = "dial" | "calls" | "sms" | "wallet";
const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };
const NETWORK: Record<string, string> = { mtn: "MTN", telecel: "Telecel", at: "AT" };

export default function Phone({ team }: { team: string }) {
  const [msisdn, setMsisdn] = useState("");
  const { data, error, refresh } = useView<PhoneView>(team, `/s/phone?msisdn=${msisdn}`, 2500);
  const [tab, setTab] = useState<Tab>("dial");
  const [seen, setSeen] = useState<Record<string, number>>({});

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's saved choice once
      setMsisdn(localStorage.getItem(`phone:${team}`) ?? "");
    } catch {}
  }, [team]);

  const lines = data?.lines ?? [];
  // Fall back to the first line when nothing (or a line that no longer exists) is chosen.
  const current = lines.some((l) => l.msisdn === msisdn) ? msisdn : (lines[0]?.msisdn ?? "");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the list of lines loaded from the server
    if (current !== msisdn) setMsisdn(current);
  }, [current, msisdn]);

  const pick = (m: string) => {
    setMsisdn(m);
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

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{teamName(team)} · Phone</div>
        <Link href={`/t/${team}`} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
          ← All systems
        </Link>
      </div>

      {!data ? (
        <Loading error={error} />
      ) : lines.length === 0 ? (
        <div className="card p-5 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">There are no phones yet.</p>
          <p className="mt-1">A phone appears here once someone has a registered SIM card. To get one:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              <Link className="underline" href={`/t/${team}/nia`}>
                NIA
              </Link>{" "}
              issues the person a Ghana Card.
            </li>
            <li>
              A telco&apos;s{" "}
              <Link className="underline" href={`/t/${team}/telco/mtn`}>
                back office
              </Link>{" "}
              adds SIM stock and authorises a registration point.
            </li>
            <li>
              The{" "}
              <Link className="underline" href={`/t/${team}/sim-agent/mtn`}>
                SIM registration point
              </Link>{" "}
              registers a SIM for them.
            </li>
          </ol>
        </div>
      ) : (
        <>
          <label className="mb-3 block text-sm">
            <span className="text-xs font-medium text-gray-600">Whose phone is this?</span>
            <select value={current} onChange={(e) => pick(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              {lines.map((l) => (
                <option key={l.msisdn} value={l.msisdn}>
                  {l.label} · {l.msisdn} · {NETWORK[l.telco]}
                  {l.status !== "active" ? " (blocked)" : ""}
                </option>
              ))}
            </select>
          </label>

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
                <CallLog rows={state.calls} calls={calls} onCall={(n) => void calls.start(n)} />
              ) : tab === "sms" ? (
                <Messages state={state} />
              ) : (
                <Wallet state={state} />
              )}
            </div>

            <nav className="grid grid-cols-4 border-t border-gray-200 bg-gray-50 text-[11px]">
              {(
                [
                  ["dial", "Phone", "☎"],
                  ["calls", "Calls", "↙"],
                  ["sms", "Messages", "✉"],
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
          {state.approvals.length} payment request(s) waiting. Dial {state.shortcode} and choose option 4 to approve or reject.
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

function Messages({ state }: { state: PhoneState }) {
  if (!state.sms.length) return <p className="p-6 text-center text-sm text-gray-500">No messages.</p>;
  return (
    <ul className="divide-y divide-gray-100">
      {state.sms.map((s) => (
        <li key={s.id} className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">{s.sender}</span>
            <span className="text-[11px] text-gray-400">{when(s.at)}</span>
          </div>
          <p className="mt-0.5 text-sm leading-snug text-gray-700">{s.body}</p>
        </li>
      ))}
    </ul>
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
