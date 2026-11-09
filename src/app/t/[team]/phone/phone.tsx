"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ghs, simClock } from "@/lib/client";
import { TelcoMark } from "@/components/telco-mark";

interface Persona {
  key: string;
  name: string;
  msisdn: string;
  telco: string;
  role: string;
  blurb: string;
}

interface PhoneState {
  msisdn: string;
  name: string;
  telco: string;
  brand: { name: string; wallet: string; color: string };
  logo: string | null;
  shortcode: string;
  kycTier: string;
  status: string;
  balance: number;
  simTime: string;
  sms: { id: number; sender: string; body: string; at: string }[];
  calls: { id: number; caller: string; caller_label: string; script: string; at: string }[];
  approvals: { ref: string; amount: number; payer_message: string; display_name: string }[];
  recent: { id: string; at: string; type: string; amount: number; status: string; from: { msisdn?: string; name?: string } | null; to: { msisdn?: string; name?: string } | null }[];
}

type Tab = "dial" | "sms" | "wallet" | "calls";

const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };

export default function Phone({ team }: { team: string }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [msisdn, setMsisdn] = useState<string>("");
  const [state, setState] = useState<PhoneState | null>(null);
  const [tab, setTab] = useState<Tab>("dial");
  const [seen, setSeen] = useState<{ sms: number; calls: number }>({ sms: 0, calls: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
     
    api<{ personas: Persona[] }>(team, "/state?limit=0").then((s) => {
      setPersonas(s.personas);
      const saved = typeof window !== "undefined" ? safeGet(`phone:${team}`) : null;
      setMsisdn(saved && s.personas.some((p) => p.msisdn === saved) ? saved : s.personas[0].msisdn);
    }, (e) => setError(e.message));
  }, [team]);

  const refresh = useCallback(async () => {
    if (!msisdn) return;
    try {
      const next = await api<PhoneState>(team, `/phone/${msisdn}`);
      setState(next);
      // On first load for a persona, treat existing messages as already seen.
      setSeen((s) => (s.sms === Number.MAX_SAFE_INTEGER ? { sms: next.sms[0]?.id ?? 0, calls: next.calls[0]?.id ?? 0 } : s));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [team, msisdn]);

  useEffect(() => {
    // Polls the sandbox server, an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const openTab = (next: Tab) => {
    // Leaving or opening a list marks what was on it as seen.
    if (state && (tab === "sms" || next === "sms")) setSeen((s) => ({ ...s, sms: state.sms[0]?.id ?? 0 }));
    if (state && (tab === "calls" || next === "calls")) setSeen((s) => ({ ...s, calls: state.calls[0]?.id ?? 0 }));
    setTab(next);
  };

  const switchPersona = (m: string) => {
    setMsisdn(m);
    setState(null);
    setSeen({ sms: Number.MAX_SAFE_INTEGER, calls: Number.MAX_SAFE_INTEGER });
    safeSet(`phone:${team}`, m);
  };

  const unreadSms = state && tab !== "sms" ? state.sms.filter((s) => s.id > seen.sms).length : 0;
  const unreadCalls = state && tab !== "calls" ? state.calls.filter((c) => c.id > seen.calls).length : 0;
  const brandColor = state?.brand.color ?? "#334155";

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{team.replace("team-", "Team ")} · Phone</div>
        <Link href={`/t/${team}/console`} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
          Team console →
        </Link>
      </div>

      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {personas.map((p) => (
          <button
            key={p.key}
            onClick={() => switchPersona(p.msisdn)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs ${p.msisdn === msisdn ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 bg-white text-gray-700"}`}
            title={p.blurb}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="flex min-h-[620px] flex-1 flex-col overflow-hidden rounded-[2rem] border-[6px] border-gray-900 bg-white shadow-xl">
        <div className="flex items-center justify-between px-5 py-2 text-xs font-semibold" style={{ background: brandColor, color: TEXT_ON[state?.telco ?? ""] ?? "#fff" }}>
          <span>{state ? `${state.brand.name} GH` : "…"}</span>
          <span>{state ? simClock(state.simTime, false) : ""}</span>
          <span>▮▮▮ 4G</span>
        </div>

        {error && <div className="bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}

        <div className="relative flex-1 overflow-y-auto">
          {!state ? (
            <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
          ) : tab === "dial" ? (
            <Dialer team={team} state={state} onDone={refresh} />
          ) : tab === "sms" ? (
            <Messages state={state} />
          ) : tab === "wallet" ? (
            <Wallet state={state} />
          ) : (
            <Calls state={state} />
          )}
        </div>

        <nav className="grid grid-cols-4 border-t border-gray-200 bg-gray-50 text-[11px]">
          {(
            [
              ["dial", "Phone", "☎"],
              ["sms", "Messages", "✉"],
              ["wallet", "MoMo", "₵"],
              ["calls", "Calls", "↙"],
            ] as [Tab, string, string][]
          ).map(([key, label, icon]) => (
            <button key={key} onClick={() => openTab(key)} className={`relative flex flex-col items-center gap-0.5 py-2 ${tab === key ? "font-semibold text-gray-900" : "text-gray-500"}`}>
              <span className="text-base leading-none">{icon}</span>
              {label}
              {key === "sms" && unreadSms > 0 && <Badge n={unreadSms} />}
              {key === "calls" && unreadCalls > 0 && <Badge n={unreadCalls} />}
            </button>
          ))}
        </nav>
      </div>

      {state && (
        <p className="mt-3 text-center text-xs text-gray-500">
          {state.name} · {state.msisdn} · wallet PIN <b>1234</b>
        </p>
      )}
    </main>
  );
}

function Badge({ n }: { n: number }) {
  return <span className="absolute right-[22%] top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">{n > 9 ? "9+" : n}</span>;
}

function Dialer({ team, state, onDone }: { team: string; state: PhoneState; onDone: () => void }) {
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
      const r = await api<{ sessionId: string; text: string; end: boolean }>(team, "/ussd", { body: { msisdn: state.msisdn, input: text, sessionId } });
      setSession({ id: r.sessionId, text: r.text, end: r.end });
      setInput("");
      if (r.end) onDone();
    } catch (e) {
      setSession({ id: "", text: (e as Error).message, end: true });
    } finally {
      setBusy(false);
    }
  };

  const dial = () => {
    if (!code) return setCode(state.shortcode);
    if (code.endsWith("#")) void send(code);
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  return (
    <div className="flex h-full flex-col items-center justify-end gap-4 p-5">
      <div className="min-h-12 w-full break-all text-center text-3xl font-light tracking-wider text-gray-900">{code || <span className="text-gray-300">{state.shortcode}</span>}</div>
      <div className="grid w-full max-w-[260px] grid-cols-3 gap-3">
        {keys.map((k) => (
          <button key={k} onClick={() => setCode((c) => (c + k).slice(0, 20))} className="aspect-square rounded-full bg-gray-100 text-2xl text-gray-900 active:bg-gray-300">
            {k}
          </button>
        ))}
      </div>
      <div className="flex w-full max-w-[260px] items-center justify-between">
        <button onClick={() => setCode(state.shortcode)} className="text-xs text-gray-500 underline">
          Fill {state.shortcode}
        </button>
        <button onClick={dial} disabled={busy} className="flex h-16 w-16 items-center justify-center rounded-full bg-green-600 text-2xl text-white shadow active:bg-green-700" aria-label="Call">
          ☎
        </button>
        <button onClick={() => setCode((c) => c.slice(0, -1))} className="w-12 text-xl text-gray-500" aria-label="Delete">
          ⌫
        </button>
      </div>

      {session && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-5">
          <div className="w-full rounded-md bg-white p-4 shadow-2xl">
            <div className="ussd-text max-h-80 overflow-y-auto text-[15px] leading-snug text-gray-900">{session.text}</div>
            {!session.end && (
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && input && send(input, session.id)}
                inputMode="tel"
                className="mt-3 w-full border-b-2 border-teal-600 py-1 text-lg outline-none"
                aria-label="USSD reply"
              />
            )}
            <div className="mt-4 flex justify-end gap-6 text-sm font-semibold uppercase tracking-wide text-teal-700">
              {session.end ? (
                <button onClick={() => { setSession(null); setCode(""); }}>OK</button>
              ) : (
                <>
                  <button onClick={() => { setSession(null); setCode(""); }}>Cancel</button>
                  <button disabled={busy || !input} onClick={() => send(input, session.id)} className="disabled:opacity-40">
                    {busy ? "…" : "Send"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Messages({ state }: { state: PhoneState }) {
  if (!state.sms.length) return <Empty text="No messages yet." />;
  return (
    <ul className="divide-y divide-gray-100">
      {state.sms.map((s) => (
        <li key={s.id} className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">{s.sender}</span>
            <span className="shrink-0 text-[11px] text-gray-400">{simClock(s.at)}</span>
          </div>
          <p className="mt-0.5 text-sm leading-snug text-gray-700">{s.body}</p>
        </li>
      ))}
    </ul>
  );
}

function Wallet({ state }: { state: PhoneState }) {
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-2xl p-5 shadow" style={{ background: state.brand.color, color: TEXT_ON[state.telco] }}>
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">{state.brand.wallet}</div>
          <span className="rounded-md bg-white p-0.5 shadow-sm">
            <TelcoMark telco={state.telco} logo={state.logo} height={32} />
          </span>
        </div>
        <div className="mt-2 text-3xl font-bold">{ghs(state.balance)}</div>
        <div className="mt-1 text-xs opacity-80">
          {state.name} · {state.kycTier} KYC{state.status !== "active" ? ` · ${state.status.toUpperCase()}` : ""}
        </div>
      </div>
      {state.approvals.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <b>{state.approvals.length} payment request{state.approvals.length > 1 ? "s" : ""} waiting.</b> Dial {state.shortcode} → option 4 to review.
          <ul className="mt-1 list-disc pl-5 text-xs">
            {state.approvals.map((a) => (
              <li key={a.ref}>
                {ghs(a.amount)} to {a.display_name}
                {a.payer_message ? ` · “${a.payer_message}”` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Recent activity</h3>
        {state.recent.length === 0 ? (
          <Empty text="No transactions yet." />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {state.recent.map((t) => {
              const out = t.from?.msisdn === state.msisdn;
              const other = out ? t.to : t.from;
              return (
                <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate text-gray-900">{other?.name ?? t.type}</div>
                    <div className="text-[11px] text-gray-400">
                      {simClock(t.at)} · {t.type}
                      {t.status !== "success" ? ` · ${t.status}` : ""}
                    </div>
                  </div>
                  <div className={`shrink-0 font-medium ${out ? "text-gray-900" : "text-green-700"}`}>
                    {out ? "−" : "+"}
                    {ghs(t.amount)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Calls({ state }: { state: PhoneState }) {
  if (!state.calls.length) return <Empty text="No calls yet." />;
  return (
    <ul className="divide-y divide-gray-100">
      {state.calls.map((c) => (
        <li key={c.id} className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">↙ {c.caller_label}</span>
            <span className="shrink-0 text-[11px] text-gray-400">{simClock(c.at)}</span>
          </div>
          <div className="text-[11px] text-gray-400">{c.caller}</div>
          <p className="mt-1 rounded-lg bg-gray-100 p-2 text-sm italic leading-snug text-gray-700">“{c.script}”</p>
        </li>
      ))}
    </ul>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-8 text-center text-sm text-gray-400">{text}</div>;
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}
