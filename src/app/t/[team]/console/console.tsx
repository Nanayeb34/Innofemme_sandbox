"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ghs, pct, simClock } from "@/lib/client";
import { InnofemmeLogo } from "@/components/brand";
import type { Metrics } from "@/engine/scoring";
import { Assistant } from "./assistant";
import { Controls } from "./controls";
import { Changes } from "./changes";
import { Feed, type FeedRow } from "./feed";
import { Snapshots } from "./snapshots";

export interface WorldState {
  world: string;
  simTime: string;
  running: boolean;
  speed: number;
  last24h: Metrics;
  overall: Metrics;
  statusCounts: Record<string, number>;
  reports: number;
  pendingProposals: number;
  feed: FeedRow[];
}

const TABS = [
  ["assistant", "Assistant"],
  ["feed", "Live feed"],
  ["changes", "Changes & impact"],
  ["controls", "Controls"],
  ["time", "Time & snapshots"],
] as const;
type TabKey = (typeof TABS)[number][0];

const SPEEDS: [number, string][] = [
  [15, "15×"],
  [60, "1 min/s"],
  [300, "5 min/s"],
  [900, "15 min/s"],
];

export default function Console({ team }: { team: string }) {
  const [state, setState] = useState<WorldState | null>(null);
  const [tab, setTab] = useState<TabKey>("assistant");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window24, setWindow24] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await api<WorldState>(team, "/state?limit=60"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [team]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the sandbox server
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const sim = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      await api(team, "/sim", { body });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const m = state ? (window24 ? state.last24h : state.overall) : null;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="mr-auto flex items-center gap-3">
            <InnofemmeLogo size={34} />
            <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">Mobile Money Fraud Hackathon</div>
            <h1 className="text-lg font-semibold leading-tight text-gray-900">{team.replace("team-", "Team ")} console</h1>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">Simulated time</div>
            <div className="font-mono text-sm font-semibold text-gray-900">
              {state ? simClock(state.simTime) : "…"} {state && <span className={state.running ? "text-green-600" : "text-amber-600"}>{state.running ? "● live" : "❚❚ paused"}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => sim("pause", { action: state?.running ? "pause" : "resume" })} className="btn">
              {state?.running ? "Pause" : "Resume"}
            </button>
            <select value={state?.speed ?? 60} onChange={(e) => sim("speed", { action: "speed", speed: Number(e.target.value) })} className="btn" aria-label="Simulation speed">
              {SPEEDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {[6, 24, 72].map((h) => (
              <button key={h} disabled={!!busy} onClick={() => sim(`ff${h}`, { action: "fast_forward", hours: h })} className="btn btn-dark">
                {busy === `ff${h}` ? "Simulating…" : `⏩ ${h < 24 ? `${h}h` : `${h / 24}d`}`}
              </button>
            ))}
            <Link href={`/t/${team}/phone`} className="btn">
              📱 Phone
            </Link>
            <Link href={`/t/${team}/docs`} className="btn">
              API
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">How your world is doing</h2>
            <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs">
              <button onClick={() => setWindow24(true)} className={`rounded-md px-2 py-1 ${window24 ? "bg-gray-900 text-white" : "text-gray-600"}`}>
                Last 24h
              </button>
              <button onClick={() => setWindow24(false)} className={`rounded-md px-2 py-1 ${!window24 ? "bg-gray-900 text-white" : "text-gray-600"}`}>
                All time
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Scams stopped" value={m ? `${m.fraudPrevented} / ${m.fraudAttempts}` : "…"} sub={m ? `${pct(m.detectionRate)} of attempts` : ""} tone="good" />
            <Kpi label="Lost to scams" value={m ? ghs(m.losses / 100) : "…"} sub={m ? `${pct(m.lossPreventionRate)} of value saved` : ""} tone="bad" />
            <Kpi label="Mule hops stopped" value={m ? `${m.launderingStopped} / ${m.launderingHops}` : "…"} sub="laundering of proceeds" />
            <Kpi label="Genuine payments stopped" value={m ? String(m.falsePositives) : "…"} sub={m ? `${pct(m.falsePositiveRate)} of ${m.legitTxns.toLocaleString()}` : ""} tone={m && m.falsePositiveRate > 0.01 ? "bad" : undefined} />
            <Kpi label="Friction" value={m ? m.frictionPer1000.toFixed(0) : "…"} sub="extra steps per 1,000 genuine" />
            <Kpi label="Sandbox score" value={m ? String(m.score) : "…"} sub="provisional, 0–100" tone="accent" />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Which individual payments were scams is hidden, as it would be for a real telco. Customers report some scams after the fact; you have {state?.reports ?? 0} reports so far.
          </p>
        </section>

        <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`relative shrink-0 px-3 py-2 text-sm ${tab === key ? "border-b-2 border-gray-900 font-semibold text-gray-900" : "text-gray-500 hover:text-gray-800"}`}>
              {label}
              {key === "assistant" && (state?.pendingProposals ?? 0) > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{state!.pendingProposals}</span>}
            </button>
          ))}
        </nav>

        {tab === "assistant" && <Assistant team={team} onChange={refresh} />}
        {tab === "feed" && <Feed rows={state?.feed ?? []} />}
        {tab === "changes" && <Changes team={team} onChange={refresh} />}
        {tab === "controls" && <Controls team={team} onChange={refresh} />}
        {tab === "time" && <Snapshots team={team} onChange={refresh} />}
      </main>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "accent" }) {
  const color = tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : tone === "accent" ? "text-indigo-700" : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}
