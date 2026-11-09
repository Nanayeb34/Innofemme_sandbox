"use client";

import { ghs, simClock } from "@/lib/client";

export interface FeedRow {
  id: string;
  at: string;
  type: string;
  channel: string;
  rail: string;
  amount: number;
  fee: number;
  status: string;
  reason: string | null;
  warned: boolean;
  secondFactor: boolean;
  checks: { id: string; name: string; action: string }[];
  from: { msisdn?: string; name?: string; telco?: string; bank?: string } | null;
  to: { msisdn?: string; name?: string; telco?: string; bank?: string } | null;
}

const STATUS: Record<string, string> = {
  success: "bg-green-50 text-green-700",
  held: "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  reversed: "bg-purple-50 text-purple-700",
  abandoned: "bg-gray-100 text-gray-600",
  failed: "bg-gray-100 text-gray-500",
};

const party = (p: FeedRow["from"]) => (p ? (p.bank ? `${p.bank} · ${p.name}` : `${p.name} · ${p.msisdn}`) : "—");

export function Feed({ rows }: { rows: FeedRow[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Your controls</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-500">{simClock(r.at)}</td>
              <td className="px-3 py-2 text-xs text-gray-700">
                {r.type}
                <div className="text-[10px] text-gray-400">
                  {r.channel}
                  {r.rail !== "onnet" ? ` · ${r.rail}` : ""}
                </div>
              </td>
              <td className="max-w-[220px] truncate px-3 py-2 text-xs text-gray-700">{party(r.from)}</td>
              <td className="max-w-[220px] truncate px-3 py-2 text-xs text-gray-700">{party(r.to)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-gray-900">{ghs(r.amount)}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS[r.status] ?? "bg-gray-100"}`}>{r.status}</span>
                {r.reason && r.status !== "success" && <div className="mt-0.5 max-w-[200px] text-[10px] text-gray-500">{r.reason}</div>}
              </td>
              <td className="px-3 py-2 text-[11px] text-gray-600">
                {r.checks.map((c) => (
                  <div key={c.id}>
                    {c.action}: {c.name}
                  </div>
                ))}
                {r.warned && <div>warning shown</div>}
                {r.secondFactor && <div>second factor</div>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                No transactions yet. Resume the clock or fast-forward.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
