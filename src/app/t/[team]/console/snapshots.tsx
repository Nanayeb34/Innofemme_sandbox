"use client";

import { useCallback, useEffect, useState } from "react";
import { api, simClock } from "@/lib/client";

interface Snapshot {
  id: string;
  label: string;
  simTime: number;
  createdAt: number;
}

export function Snapshots({ team, onChange }: { team: string; onChange: () => void }) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api<{ snapshots: Snapshot[] }>(team, "/snapshots").then((r) => setSnaps(r.snapshots)), [team]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(done);
      await load();
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card p-4">
        <h3 className="font-semibold text-gray-900">Save a snapshot</h3>
        <p className="mt-1 text-sm text-gray-600">Saves your whole world (people, balances, history and settings) so you can roll back to it later.</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api(team, "/snapshots", { body: { label: label || "Snapshot" } }), "Snapshot saved.");
            setLabel("");
          }}
        >
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Before new warning screen" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button disabled={busy} className="btn btn-dark">
            Save
          </button>
        </form>
        {msg && <p className="mt-2 text-xs text-gray-600">{msg}</p>}

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h3 className="font-semibold text-gray-900">Start over</h3>
          <p className="mt-1 text-sm text-gray-600">Resets your world to the original starting point, wiping your settings and history. Saved snapshots stay available to roll back to.</p>
          {confirmReset ? (
            <div className="mt-3 flex gap-2">
              <button disabled={busy} onClick={() => run(() => api(team, "/sim", { body: { action: "reset" } }), "World reset.").then(() => setConfirmReset(false))} className="btn btn-danger">
                Yes, reset my world
              </button>
              <button onClick={() => setConfirmReset(false)} className="btn">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)} className="btn btn-danger mt-3">
              Reset world…
            </button>
          )}
        </div>
      </section>

      <section className="card p-4">
        <h3 className="font-semibold text-gray-900">Snapshots</h3>
        {snaps.length === 0 && <p className="mt-2 text-sm text-gray-500">None yet.</p>}
        <ul className="mt-2 divide-y divide-gray-100">
          {snaps.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 py-2">
              <div>
                <div className="text-sm font-medium text-gray-900">{s.label}</div>
                <div className="text-[11px] text-gray-500">
                  World time {simClock(new Date(s.simTime).toISOString())} · saved {new Date(s.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <button disabled={busy} onClick={() => run(() => api(team, `/snapshots/${s.id}`, { method: "POST" }), `Rolled back to “${s.label}”.`)} className="btn">
                Roll back
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
