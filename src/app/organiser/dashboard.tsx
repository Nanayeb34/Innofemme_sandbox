"use client";

import { useCallback, useEffect, useState } from "react";
import { ghs, when } from "@/lib/client";
import { askConfirm } from "@/stores/ui";

interface TeamRow {
  id: string;
  name: string;
  hubUrl: string;
  people: number;
  sims: number;
  wallets: number;
  agents: number;
  bankAccounts: number;
  payments: number;
  value: number;
  settingsChanges: number;
  lastActivity: number | null;
}

interface Access {
  id: string;
  name: string;
  joinUrl: string;
  qr: string;
}

export default function Dashboard({ access }: { access: Access[] }) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/org/overview", { cache: "no-store" });
    if (r.ok) setTeams((await r.json()).teams);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the sandbox server
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const reset = async () => {
    if (!(await askConfirm({ title: `Wipe ${selected.join(", ")}?`, message: "Each of these worlds goes back to an empty country. Everything those teams built will be lost.", confirm: "Wipe them", danger: true }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/org/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reset", worlds: selected }) });
      const j = await r.json();
      setMsg(r.ok ? `Reset ${Object.keys(j.results).length} world(s).` : j.error);
      setSelected([]);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    if (!(await askConfirm({ title: `Load the simulated country into ${selected.join(", ")}?`, message: "100,023 transactions, 22% fraud. What each team has built is kept as a save point.", confirm: "Load it" }))) return;
    setBusy(true);
    setMsg("Loading the simulated country. This can take up to a minute the first time…");
    try {
      const r = await fetch("/api/org/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "simulate", worlds: selected }) });
      const j = await r.json();
      setMsg(r.ok ? `Loaded simulated data into ${Object.keys(j.results).length} world(s).` : j.error);
      setSelected([]);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6">
      <section className="card p-5">
        <h2 className="font-semibold text-gray-900">Running the hackathon</h2>
        <ol className="mt-2 grid gap-3 text-sm text-gray-700 md:grid-cols-3">
          <li>
            <b className="text-gray-900">1. Print team cards.</b> Use <i>Print team QR cards</i> (top right). Each card carries one team&apos;s private QR code.
          </li>
          <li>
            <b className="text-gray-900">2. Hand out one card per team.</b> Members scan it. It opens their team&apos;s own copy of the country&apos;s systems, which starts empty.
          </li>
          <li>
            <b className="text-gray-900">3. Follow progress below.</b> The table shows how far each team has built its world. Open any team&apos;s systems from the table.
          </li>
        </ol>
      </section>

      <section className="card mt-5 overflow-x-auto p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Team worlds</h2>
          <div className="flex items-center gap-2">
            {msg && <span className="text-sm text-gray-600">{msg}</span>}
            <button disabled={busy || !selected.length} onClick={simulate} className="btn btn-dark">
              Load simulated data into selected
            </button>
            <button disabled={busy || !selected.length} onClick={reset} className="btn btn-danger">
              Reset selected to empty
            </button>
          </div>
        </div>
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
              <th className="px-2 py-2"></th>
              <th className="px-2 py-2 font-medium">Team</th>
              <th className="px-2 py-2 text-right font-medium">Ghana Cards</th>
              <th className="px-2 py-2 text-right font-medium">SIMs</th>
              <th className="px-2 py-2 text-right font-medium">Wallets</th>
              <th className="px-2 py-2 text-right font-medium">Agents</th>
              <th className="px-2 py-2 text-right font-medium">Bank accounts</th>
              <th className="px-2 py-2 text-right font-medium">Payments</th>
              <th className="px-2 py-2 text-right font-medium">Value moved</th>
              <th className="px-2 py-2 text-right font-medium">Settings changed</th>
              <th className="px-2 py-2 font-medium">Last activity</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="border-b border-gray-100 last:border-0">
                <td className="px-2 py-2">
                  <input type="checkbox" aria-label={`Select ${t.name}`} checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} />
                </td>
                <td className="px-2 py-2 font-medium text-gray-900">{t.name}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.people}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.sims}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.wallets}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.agents}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.bankAccounts}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.payments}</td>
                <td className="px-2 py-2 text-right tabular-nums">{ghs(t.value)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{t.settingsChanges}</td>
                <td className="px-2 py-2 text-gray-500">{t.lastActivity ? when(new Date(t.lastActivity).toISOString()) : "not started"}</td>
                <td className="px-2 py-2">
                  <a href={`/t/${t.id}`} className="underline">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card mt-5 p-5">
        <h2 className="font-semibold text-gray-900">Team access</h2>
        <p className="mt-1 text-sm text-gray-600">Each team&apos;s private link and QR code. Anyone with the link can use that team&apos;s world.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {access.map((a) => (
            <div key={a.id} className="rounded-lg border border-gray-200 p-3 text-center">
              <div className="font-medium text-gray-900">{a.name}</div>
              <div className="mx-auto mt-2 w-[132px]" dangerouslySetInnerHTML={{ __html: a.qr }} />
              <button onClick={() => navigator.clipboard?.writeText(a.joinUrl)} className="mt-2 text-xs underline">
                Copy link
              </button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
