"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ghs, pct, simClock } from "@/lib/client";
import type { Metrics } from "@/engine/scoring";

interface TeamRow {
  id: string;
  name: string;
  joinUrl: string | null;
  consoleUrl: string;
  simTime: string;
  running: boolean;
  speed: number;
  changes: number;
  hidden: { id: string; perDay: number }[];
  overall: Metrics;
  last24h: Metrics;
  byScenario: { scenario: string; status: string; n: number; value: number }[];
}

interface Access {
  id: string;
  name: string;
  joinUrl: string;
  qr: string;
}

export default function Dashboard({ scenarios, access }: { scenarios: Record<string, string>; access: Access[] }) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [surprise, setSurprise] = useState("sim_swap");
  const [perDay, setPerDay] = useState(40);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/org/overview", { cache: "no-store" });
    if (r.ok) setTeams((await r.json()).teams);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the sandbox server
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (body: Record<string, unknown>, label: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/org/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, worlds: selected.length ? selected : undefined }) });
      const j = await r.json();
      setMsg(r.ok ? `${label}: done for ${Object.keys(j.results).length} world(s).` : j.error);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const ranked = [...teams].sort((a, b) => b.overall.score - a.overall.score);
  const target = selected.length ? `${selected.length} selected` : "all worlds";

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6">
      <section className="card p-5">
        <h2 className="font-semibold text-gray-900">Running the hackathon</h2>
        <ol className="mt-2 grid gap-3 text-sm text-gray-700 md:grid-cols-4">
          <li>
            <b className="text-gray-900">1. Print team cards.</b> Use <i>Print team QR cards</i> (top right). Each card carries one team&apos;s private QR code.
          </li>
          <li>
            <b className="text-gray-900">2. Hand out one card per team.</b> Members scan it with their phone camera. It opens the team&apos;s phone, with a link to their console.
          </li>
          <li>
            <b className="text-gray-900">3. Follow progress below.</b> The leaderboard updates live. Open any team&apos;s phone or console from <i>Team access</i>.
          </li>
          <li>
            <b className="text-gray-900">4. Demo day.</b> Launch a surprise attack across all teams and compare how each one copes.
          </li>
        </ol>
      </section>

      <section className="card mt-5 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-1 text-gray-600">Apply to {target}:</span>
          <button disabled={busy} onClick={() => act({ action: "pause" }, "Paused")} className="btn">
            Pause
          </button>
          <button disabled={busy} onClick={() => act({ action: "resume" }, "Resumed")} className="btn">
            Resume
          </button>
          <button disabled={busy} onClick={() => act({ action: "fast_forward", hours: 24 }, "Fast-forwarded 24h")} className="btn">
            ⏩ 24h
          </button>
          <select onChange={(e) => act({ action: "speed", speed: Number(e.target.value) }, "Speed set")} className="btn" defaultValue="">
            <option value="" disabled>
              Speed…
            </option>
            <option value="60">1 min/s</option>
            <option value="300">5 min/s</option>
            <option value="900">15 min/s</option>
          </select>
          <span className="mx-2 h-6 w-px bg-gray-200" />
          <span className="text-gray-600">Surprise attack:</span>
          <select value={surprise} onChange={(e) => setSurprise(e.target.value)} className="btn">
            {Object.entries(scenarios).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <input type="number" value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} className="w-20 rounded-lg border border-gray-300 px-2 py-1.5" aria-label="Attacks per day" />
          <span className="text-xs text-gray-500">/day</span>
          <button disabled={busy} onClick={() => act({ action: "surprise", scenario: surprise, perDay }, "Surprise launched")} className="btn btn-dark">
            Launch
          </button>
          <button disabled={busy} onClick={() => act({ action: "clear_surprise" }, "Surprise cleared")} className="btn">
            Clear
          </button>
          <span className="mx-2 h-6 w-px bg-gray-200" />
          <button
            disabled={busy || !selected.length}
            onClick={() => confirm(`Reset ${selected.join(", ")} to the starting world?`) && act({ action: "reset" }, "Reset")}
            className="btn btn-danger"
            title="Select worlds first"
          >
            Reset selected
          </button>
        </div>
        {msg && <p className="mt-2 text-xs text-gray-600">{msg}</p>}
      </section>

      <section className="card mt-5 overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">
                <input type="checkbox" checked={selected.length === teams.length && teams.length > 0} onChange={(e) => setSelected(e.target.checked ? teams.map((t) => t.id) : [])} aria-label="Select all" />
              </th>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">World</th>
              <th className="px-3 py-2">Clock</th>
              <th className="px-3 py-2 text-right">Score</th>
              <th className="px-3 py-2 text-right">Scams stopped</th>
              <th className="px-3 py-2 text-right">Value saved</th>
              <th className="px-3 py-2 text-right">Lost</th>
              <th className="px-3 py-2 text-right">Mule hops stopped</th>
              <th className="px-3 py-2 text-right">Genuine stopped</th>
              <th className="px-3 py-2 text-right">Friction/1k</th>
              <th className="px-3 py-2 text-right">Changes</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {ranked.map((t, i) => (
              <Fragment key={t.id}>
                <tr>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} aria-label={`Select ${t.name}`} />
                  </td>
                  <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {t.name}
                    {t.hidden.length > 0 && <span className="ml-2 rounded bg-red-100 px-1.5 text-[10px] text-red-700">surprise</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-600">
                    {simClock(t.simTime)} {t.running ? "●" : "❚❚"}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-indigo-700">{t.overall.score}</td>
                  <td className="px-3 py-2 text-right">
                    {t.overall.fraudPrevented}/{t.overall.fraudAttempts} <span className="text-xs text-gray-500">({pct(t.overall.detectionRate)})</span>
                  </td>
                  <td className="px-3 py-2 text-right">{pct(t.overall.lossPreventionRate)}</td>
                  <td className="px-3 py-2 text-right">{ghs(t.overall.losses / 100)}</td>
                  <td className="px-3 py-2 text-right">
                    {t.overall.launderingStopped}/{t.overall.launderingHops}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {t.overall.falsePositives} <span className="text-xs text-gray-500">({pct(t.overall.falsePositiveRate)})</span>
                  </td>
                  <td className="px-3 py-2 text-right">{t.overall.frictionPer1000.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right">{t.changes}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <button onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="underline">
                      scenarios
                    </button>{" "}
                    · <a href={t.consoleUrl} target="_blank" className="underline">console</a>
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr>
                    <td colSpan={13} className="bg-gray-50 px-6 py-3">
                      <ScenarioBreakdown rows={t.byScenario} labels={scenarios} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
      <p className="mt-2 text-xs text-gray-500">
        Score (provisional) = 50% value saved + 30% scams stopped + 20% mule hops stopped, minus 3 points per 1% of genuine payments stopped and 1 point per 10 friction events per 1,000 genuine payments.
      </p>

      <section className="mt-8">
        <h2 className="font-semibold text-gray-900">Team access</h2>
        <p className="mt-1 text-sm text-gray-600">Each QR code is private to its team. Anyone who scans it joins that team.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {access.map((a) => (
            <div key={a.id} className="card flex flex-col items-center p-3 text-center">
              <div className="font-semibold text-gray-900">{a.name}</div>
              <div className="mt-2 w-[132px]" dangerouslySetInnerHTML={{ __html: a.qr }} />
              <div className="mt-2 flex gap-3 text-xs">
                <a href={`/t/${a.id}/phone`} target="_blank" className="underline">
                  Phone
                </a>
                <a href={`/t/${a.id}/console`} target="_blank" className="underline">
                  Console
                </a>
                <button onClick={() => navigator.clipboard?.writeText(a.joinUrl)} className="underline">
                  Copy link
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ScenarioBreakdown({ rows, labels }: { rows: TeamRow["byScenario"]; labels: Record<string, string> }) {
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) by.set(r.scenario, { ...(by.get(r.scenario) ?? {}), [r.status]: r.n });
  return (
    <table className="text-xs">
      <thead className="text-gray-500">
        <tr>
          <th className="pr-6 text-left font-medium">Scenario (ground truth)</th>
          {["success", "held", "blocked", "abandoned", "reversed"].map((s) => (
            <th key={s} className="px-2 text-right font-medium">
              {s}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...by.entries()].map(([s, c]) => (
          <tr key={s}>
            <td className="pr-6">{labels[s] ?? s}</td>
            {["success", "held", "blocked", "abandoned", "reversed"].map((k) => (
              <td key={k} className="px-2 text-right">
                {c[k] ?? 0}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
