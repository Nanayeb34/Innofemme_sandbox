"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ghs, pct, simClock } from "@/lib/client";
import type { ChangeImpact } from "@/engine/scoring";

export function Changes({ team, onChange }: { team: string; onChange: () => void }) {
  const [changes, setChanges] = useState<ChangeImpact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<{ changes: ChangeImpact[] }>(team, "/history").then((r) => setChanges(r.changes), (e) => setError(e.message)), [team]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const undo = async (id: number) => {
    try {
      await api(team, `/history/${id}`, { method: "POST" });
      await load();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!changes) return <p className="text-sm text-gray-500">Loading…</p>;
  if (changes.length === 0) return <p className="text-sm text-gray-500">No changes yet. Ask the assistant or use Controls, then fast-forward to see the impact here.</p>;

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <p className="text-xs text-gray-500">Each change compares the 24 simulated hours before it with the period it has been live.</p>
      {changes.map((c) => {
        const hours = Math.max(0, (c.after.to - c.after.from) / 3600000);
        return (
          <div key={c.id} className={`card p-4 ${c.undone ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {c.surface} · by {c.author} · {simClock(new Date(c.atSim).toISOString())}
                </div>
                <div className="mt-0.5 font-medium text-gray-900">{c.summary}</div>
              </div>
              {c.undone ? <span className="text-xs text-gray-500">undone</span> : <button onClick={() => undo(c.id)} className="btn">↶ Undo</button>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
              <Compare label="Scams stopped" before={pct(c.before.detectionRate)} after={pct(c.after.detectionRate)} better={c.after.detectionRate >= c.before.detectionRate} />
              <Compare label="Value saved" before={pct(c.before.lossPreventionRate)} after={pct(c.after.lossPreventionRate)} better={c.after.lossPreventionRate >= c.before.lossPreventionRate} />
              <Compare label="Lost to scams" before={ghs(c.before.losses / 100)} after={ghs(c.after.losses / 100)} />
              <Compare label="Genuine stopped" before={pct(c.before.falsePositiveRate)} after={pct(c.after.falsePositiveRate)} better={c.after.falsePositiveRate <= c.before.falsePositiveRate} />
              <Compare label="Friction /1000" before={c.before.frictionPer1000.toFixed(0)} after={c.after.frictionPer1000.toFixed(0)} better={c.after.frictionPer1000 <= c.before.frictionPer1000} />
            </div>
            {hours < 6 && <p className="mt-2 text-[11px] text-amber-700">Only {hours.toFixed(1)} simulated hours since this change. Fast-forward for a fair comparison.</p>}
          </div>
        );
      })}
    </div>
  );
}

function Compare({ label, before, after, better }: { label: string; before: string; after: string; better?: boolean }) {
  return (
    <div className="rounded-lg bg-gray-50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-gray-500">
        {before} → <span className={better === undefined ? "font-semibold text-gray-900" : better ? "font-semibold text-green-700" : "font-semibold text-red-700"}>{after}</span>
      </div>
    </div>
  );
}
