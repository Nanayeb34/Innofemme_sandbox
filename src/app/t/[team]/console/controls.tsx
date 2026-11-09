"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client";
import { SCENARIOS, type FraudChecks, type Scenarios } from "@/engine/config/schemas";

const SURFACES = [
  ["fraudChecks", "Fraud checks"],
  ["scenarios", "Scam scenarios"],
  ["menus", "USSD menus"],
  ["rules", "Rules & limits"],
  ["notifications", "Notifications"],
] as const;
type SurfaceKey = (typeof SURFACES)[number][0];

export function Controls({ team, onChange }: { team: string; onChange: () => void }) {
  const [surface, setSurface] = useState<SurfaceKey>("fraudChecks");
  const [value, setValue] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const v = await api(team, `/config/${surface}`);
    setValue(v);
    setText(JSON.stringify(v, null, 2));
    setErrors([]);
  }, [team, surface]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches the selected surface from the server
    load();
  }, [load]);

  const save = async (next: unknown, why: string) => {
    setErrors([]);
    try {
      await api(team, `/config/${surface}`, { method: "PUT", body: { value: next, summary: why } });
      setSaved(`Saved: ${why}`);
      setSummary("");
      await load();
      onChange();
    } catch (e) {
      setErrors(e instanceof ApiError && e.details ? e.details : [(e as Error).message]);
    }
  };

  const saveJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([`Not valid JSON: ${(e as Error).message}`]);
      return;
    }
    void save(parsed, summary.trim() || `Edited ${surface} in Controls`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {SURFACES.map(([k, l]) => (
          <button
            key={k}
            onClick={() => {
              setSaved(null);
              setSurface(k);
            }} className={`btn ${surface === k ? "btn-dark" : ""}`}>
            {l}
          </button>
        ))}
      </div>
      {saved && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{saved}. See its impact under Changes & impact.</div>}

      {surface === "scenarios" && value != null && <ScenarioToggles value={value as Scenarios} onSave={save} />}
      {surface === "fraudChecks" && value != null && <CheckToggles value={value as FraudChecks} onSave={save} />}

      <details className="card p-4" open={surface === "menus" || surface === "rules" || surface === "notifications"}>
        <summary className="cursor-pointer text-sm font-semibold text-gray-800">Edit as JSON (for coders)</summary>
        <p className="mt-2 text-xs text-gray-500">
          Everything is validated before it is saved, and every save can be undone. Non-coders: ask the assistant instead. It makes the same edits for you.
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="mt-3 h-[420px] w-full rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-xs leading-relaxed" />
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe the change (shown in history)" className="min-w-[240px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button onClick={saveJson} className="btn btn-dark">
            Validate & save
          </button>
          <button onClick={load} className="btn">
            Revert edits
          </button>
        </div>
        {errors.length > 0 && (
          <ul className="mt-2 list-disc rounded-lg bg-red-50 py-2 pl-8 pr-3 text-xs text-red-700">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

function ScenarioToggles({ value, onSave }: { value: Scenarios; onSave: (v: unknown, why: string) => void }) {
  return (
    <div className="card divide-y divide-gray-100">
      <div className="p-4 text-sm text-gray-600">Choose which scams run against your world and how often. Turn one up to stress-test a defence.</div>
      {value.scenarios.map((s, i) => (
        <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <label className="flex min-w-[260px] flex-1 items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => {
                const scenarios = value.scenarios.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x));
                onSave({ ...value, scenarios }, `${e.target.checked ? "Enabled" : "Disabled"} scenario: ${SCENARIOS[s.id]}`);
              }}
            />
            {SCENARIOS[s.id]}
          </label>
          <select
            value={s.perDay}
            onChange={(e) => {
              const scenarios = value.scenarios.map((x, j) => (j === i ? { ...x, perDay: Number(e.target.value) } : x));
              onSave({ ...value, scenarios }, `Set ${SCENARIOS[s.id]} to ${e.target.value} attempts per day`);
            }}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            {[...new Set([0, 3, 6, 10, 20, 30, 60, 120, s.perDay])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n} / day
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

function CheckToggles({ value, onSave }: { value: FraudChecks; onSave: (v: unknown, why: string) => void }) {
  return (
    <div className="card divide-y divide-gray-100">
      <div className="p-4 text-sm text-gray-600">These checks run on every payment before money moves. Add new ones with the assistant or the JSON editor below.</div>
      {value.checks.map((c, i) => (
        <label key={c.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={c.enabled}
            onChange={(e) => {
              const checks = value.checks.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x));
              onSave({ ...value, checks }, `${e.target.checked ? "Enabled" : "Disabled"} check: ${c.name}`);
            }}
          />
          <span>
            <span className="font-medium text-gray-900">{c.name}</span>
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
              {c.action}
              {c.holdMinutes ? ` ${c.holdMinutes} min` : ""}
            </span>
            <span className="block text-[11px] text-gray-500">applies to {c.appliesTo.join(", ")}</span>
          </span>
        </label>
      ))}
      <div className="px-4 py-2.5 text-xs text-gray-500">
        Team model webhook: {value.webhook.enabled ? `on → ${value.webhook.url}` : "off"} (set it in the JSON editor).
      </div>
    </div>
  );
}
