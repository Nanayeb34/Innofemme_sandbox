"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, ghs, teamName, when } from "@/lib/client";

/** Loads an institution's view and keeps it fresh. */
export function useView<T>(team: string, path: string, everyMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await api<T>(team, path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [team, path]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the sandbox server, an external system
    refresh();
    // A tab nobody is looking at stops asking, and catches up the moment it is looked at again.
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, everyMs);
    const seen = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [refresh, everyMs]);
  return { data, error, refresh };
}

export function Shell({
  team, title, subtitle, color = "#111827", textOn = "#ffffff", mark, right, back, children,
}: {
  team: string; title: string; subtitle: string; color?: string; textOn?: string; mark?: ReactNode; right?: ReactNode;
  /** Where the header's back link goes. Defaults to the list of all systems. */
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header style={{ background: color, color: textOn }}>
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          {mark}
          <div className="mr-auto min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
              {teamName(team)} · {subtitle}
            </div>
            <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
          </div>
          {right}
          <Link href={back?.href ?? `/t/${team}`} className="rounded-lg border border-current/30 px-3 py-1.5 text-sm font-medium hover:bg-black/10">
            ← {back?.label ?? "All systems"}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">{children}</main>
    </div>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [K, string, number?])[]; value: K; onChange: (k: K) => void }) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">
      {tabs.map(([key, label, n]) => (
        <button key={key} onClick={() => onChange(key)} className={`shrink-0 px-3 py-2 text-sm ${value === key ? "border-b-2 border-gray-900 font-semibold text-gray-900" : "text-gray-500 hover:text-gray-800"}`}>
          {label}
          {n !== undefined && <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">{n}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-gray-900"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

export function Section({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card mb-4">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="font-semibold text-gray-900">{title}</h2>
          {hint && <p className="mt-0.5 max-w-3xl text-sm text-gray-600">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES = { green: "bg-green-100 text-green-800", red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-800", gray: "bg-gray-100 text-gray-700", blue: "bg-blue-100 text-blue-800" };
export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  active: "green", success: "green", SUCCESSFUL: "green", MATCH: "green", commit: "green", connected: "green",
  blocked: "red", failed: "red", FAILED: "red", frozen: "red", locked: "red", suspended: "red", deactivated: "red", reject: "red", disconnected: "red", NOT_FOUND: "red", BIOMETRIC_MISMATCH: "red", CARD_SUSPENDED: "red",
  PENDING: "amber", reversed: "amber", missed: "amber", declined: "amber", busy: "amber", ringing: "blue",
  open: "amber", awaiting_recipient: "amber", with_other_network: "blue", resolved: "green", rejected: "red", dispute: "blue", in_stock: "blue", settlement: "blue",
};
export function Status({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value] ?? "gray"}>{value.replace(/_/g, " ").toLowerCase()}</Badge>;
}

export interface Col<T> {
  label: string;
  cell: (row: T) => ReactNode;
  right?: boolean;
}

export function Table<T>({ rows, cols, empty, onRow, max = 200 }: { rows: T[]; cols: Col<T>[]; empty: string; onRow?: (row: T) => void; max?: number }) {
  if (!rows.length) return <p className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">{empty}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
            {cols.map((c) => (
              <th key={c.label} className={`px-2 py-2 font-medium ${c.right ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(r) : undefined} className={`border-b border-gray-100 last:border-0 ${onRow ? "cursor-pointer hover:bg-gray-50" : ""}`}>
              {cols.map((c) => (
                <td key={c.label} className={`px-2 py-2 align-top ${c.right ? "text-right tabular-nums" : ""}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "password" | "select" | "date";
  options?: (readonly [string, string])[];
  placeholder?: string;
  optional?: boolean;
  hint?: string;
  initial?: string;
}

/** A form that performs one action at one institution and reports what happened. */
export function ActionForm({
  team, path, action, fields, submit, extra, onDone, keep = [], disabled,
}: {
  team: string; path: string; action: string; fields: Field[]; submit: string; extra?: Record<string, unknown>; onDone?: () => void; keep?: string[]; disabled?: string;
}) {
  const initial = () => Object.fromEntries(fields.map((f) => [f.name, f.initial ?? (f.type === "select" ? (f.options?.[0]?.[0] ?? "") : "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      // A select shows its first option when nothing valid is chosen, so send what is on screen.
      const sent = Object.fromEntries(fields.map((f) => [f.name, f.type === "select" && !(f.options ?? []).some(([v]) => v === values[f.name]) ? (f.options?.[0]?.[0] ?? "") : (values[f.name] ?? "")]));
      const r = await api<{ message?: string }>(team, path, { body: { action, ...extra, ...sent } });
      setResult({ ok: true, text: r.message ?? "Done." });
      setValues((v) => ({ ...initial(), ...Object.fromEntries(keep.map((k) => [k, v[k]])) }));
      onDone?.();
    } catch (err) {
      const d = err instanceof ApiError && err.details ? ` ${err.details.join("; ")}` : "";
      setResult({ ok: false, text: (err as Error).message + d });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={run} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => {
          const options = f.options ?? [];
          // A select whose options changed (e.g. the first agent was just created) falls back to its first option.
          const value = f.type === "select" && !options.some(([v]) => v === values[f.name]) ? (options[0]?.[0] ?? "") : (values[f.name] ?? "");
          return (
            <label key={f.name} className="block text-sm">
              <span className="font-medium text-gray-700">
                {f.label}
                {f.optional && <span className="font-normal text-gray-400"> (optional)</span>}
              </span>
              {f.type === "select" ? (
                <select value={value} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                  {options.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === "number" ? "text" : (f.type ?? "text")}
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  value={value}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  placeholder={f.placeholder}
                  required={!f.optional}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              )}
              {f.hint && <span className="mt-0.5 block text-xs text-gray-500">{f.hint}</span>}
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy || !!disabled} className="btn btn-dark">
          {busy ? "Working…" : submit}
        </button>
        {disabled && <span className="text-xs text-gray-500">{disabled}</span>}
      </div>
      {result && <p className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>{result.text}</p>}
    </form>
  );
}

/** A one-click action, e.g. suspend, block, settle. */
export function ActionButton({ team, path, body, children, confirmText, onDone, danger, dark }: { team: string; path: string; body: Record<string, unknown>; children: ReactNode; confirmText?: string; onDone?: (r: unknown) => void; danger?: boolean; dark?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      onDone?.(await api(team, path, { body }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button onClick={run} disabled={busy} className={`btn ${danger ? "btn-danger" : ""} ${dark ? "btn-dark" : ""} !px-2 !py-1 !text-xs`}>
        {busy ? "…" : children}
      </button>
      {error && <span className="max-w-[220px] text-[11px] text-red-600">{error}</span>}
    </span>
  );
}

export interface TxnRow {
  id: string;
  ref: string;
  at: string;
  type: string;
  channel: string;
  rail: string;
  amount: number;
  fee: number;
  commission: number;
  status: string;
  reason: string | null;
  reference: string | null;
  from: string;
  to: string;
}

const TYPE_LABEL: Record<string, string> = {
  p2p: "Transfer", merchant: "Merchant payment", cashin: "Cash-in", cashout: "Cash-out", float: "Agent float", wallet_to_bank: "Wallet → bank", bank_to_wallet: "Bank → wallet",
  bank_transfer: "Bank transfer", deposit: "Cash deposit", withdrawal: "Cash withdrawal", reversal: "Reversal", settlement: "Settlement", hold: "Funds put on hold", hold_release: "Hold released",
};

interface TxnDetail {
  txn: TxnRow;
  postings: { account: string; amount: number }[];
  switchLog: { step: string; from_party: string; to_party: string; detail: string; at: string }[];
}

/** Transactions; click one to see the ledger postings and switch messages behind it. */
export function TxnTable({ team, rows, empty = "No transactions yet.", action, path = "/s/hub" }: { team: string; rows: TxnRow[]; empty?: string; action?: (t: TxnRow) => ReactNode; path?: string }) {
  const [detail, setDetail] = useState<TxnDetail | null>(null);
  const open = async (t: TxnRow) => setDetail(await api<TxnDetail>(team, path, { body: { action: "txn", txnId: t.id } }));
  const cols: Col<TxnRow>[] = [
    { label: "Time", cell: (t) => <span className="whitespace-nowrap text-gray-500">{when(t.at)}</span> },
    { label: "Type", cell: (t) => <span className="whitespace-nowrap">{TYPE_LABEL[t.type] ?? t.type}</span> },
    { label: "From", cell: (t) => t.from },
    { label: "To", cell: (t) => t.to },
    { label: "Amount", right: true, cell: (t) => ghs(t.amount) },
    { label: "Fee", right: true, cell: (t) => (t.fee ? ghs(t.fee) : "–") },
    { label: "Rail", cell: (t) => <Badge tone={t.rail === "switch" ? "blue" : "gray"}>{t.rail}</Badge> },
    { label: "Status", cell: (t) => (<><Status value={t.status} />{t.reason && <div className="mt-0.5 max-w-[220px] text-[11px] text-gray-500">{t.reason}</div>}</>) },
  ];
  if (action) cols.push({ label: "", cell: action });
  return (
    <>
      <Table rows={rows} cols={cols} empty={empty} onRow={open} />
      {detail && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setDetail(null)}>
          <div className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-gray-900">
                  {TYPE_LABEL[detail.txn.type] ?? detail.txn.type} · {ghs(detail.txn.amount)}
                </h3>
                <p className="text-xs text-gray-500">
                  Trans ID {detail.txn.ref} · {when(detail.txn.at)} · via {detail.txn.channel}
                </p>
              </div>
              <button onClick={() => setDetail(null)} className="btn">
                Close
              </button>
            </div>
            <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Ledger postings (always add up to zero)</h4>
            {detail.postings.length ? (
              <table className="mt-1 w-full text-sm">
                <tbody>
                  {detail.postings.map((p, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="py-1.5 font-mono text-xs">{p.account}</td>
                      <td className={`py-1.5 text-right tabular-nums ${p.amount < 0 ? "text-red-700" : "text-green-700"}`}>
                        {p.amount > 0 ? "+" : ""}
                        {p.amount.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-1 text-sm text-gray-500">No money moved: the payment was refused.</p>
            )}
            {detail.switchLog.length > 0 && (
              <>
                <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">National switch messages</h4>
                <ol className="mt-1 space-y-1 text-sm">
                  {detail.switchLog.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <Status value={s.step} />
                      <span className="text-gray-700">{s.detail}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export interface ActivityRow {
  id: number;
  at: string;
  systemName: string;
  summary: string;
}

export function Activity({ rows, showSystem, empty = "Nothing has happened here yet." }: { rows: ActivityRow[]; showSystem?: boolean; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <ul className="divide-y divide-gray-100 text-sm">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-wrap gap-x-3 py-1.5 sm:flex-nowrap">
          <span className="w-24 shrink-0 text-xs text-gray-500">{when(a.at)}</span>
          {showSystem && <span className="w-28 shrink-0 text-xs font-medium text-gray-700">{a.systemName}</span>}
          <span className="min-w-0 basis-full break-words text-gray-800 sm:basis-auto">{a.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** Edits one part of an institution's settings as JSON. Everything is validated before it is saved. */
export function SettingsJson({ team, path, pointer, value, onSaved, rows = 14 }: { team: string; path: string; pointer: string; value: unknown; onSaved: () => void; rows?: number }) {
  const original = JSON.stringify(value, null, 2);
  const [text, setText] = useState(original);
  const [loaded, setLoaded] = useState(original);
  const [summary, setSummary] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Pick up changes saved elsewhere, unless this editor has unsaved edits.
  if (original !== loaded && text === loaded) {
    setLoaded(original);
    setText(original);
  }
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return setResult({ ok: false, text: `Not valid JSON: ${(e as Error).message}` });
    }
    try {
      await api(team, path, { body: { action: "settings", operations: [{ op: "replace", path: pointer, value: parsed }], summary: summary.trim() || `Edited ${pointer.slice(1).replace(/\//g, " › ")}` } });
      setResult({ ok: true, text: "Saved." });
      setLoaded(text);
      setSummary("");
      onSaved();
    } catch (e) {
      const d = e instanceof ApiError && e.details ? ` ${e.details.join("; ")}` : "";
      setResult({ ok: false, text: (e as Error).message + d });
    }
  };
  return (
    <div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={rows} className="w-full rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-xs leading-relaxed" />
      <div className="mt-2 flex flex-wrap gap-2">
        <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe the change (shown in history)" className="min-w-[220px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <button onClick={save} disabled={text === loaded} className="btn btn-dark">
          Check and save
        </button>
        <button onClick={() => setText(loaded)} disabled={text === loaded} className="btn">
          Discard edits
        </button>
      </div>
      {result && <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>{result.text}</p>}
    </div>
  );
}

/** Saves a few simple settings (numbers, switches) without touching JSON. */
export function SettingsForm({ team, path, fields, onSaved }: { team: string; path: string; fields: { pointer: string; label: string; value: number | boolean; hint?: string }[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    const operations = fields.filter((f) => f.pointer in draft).map((f) => ({ op: "add", path: f.pointer, value: typeof f.value === "boolean" ? draft[f.pointer] : Number(draft[f.pointer]) }));
    const summary = fields.filter((f) => f.pointer in draft).map((f) => `${f.label}: ${String(f.value)} → ${String(draft[f.pointer])}`).join("; ");
    try {
      await api(team, path, { body: { action: "settings", operations, summary } });
      setDraft({});
      setResult({ ok: true, text: "Saved." });
      onSaved();
    } catch (e) {
      const d = e instanceof ApiError && e.details ? ` ${e.details.join("; ")}` : "";
      setResult({ ok: false, text: (e as Error).message + d });
    }
  };
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <label key={f.pointer} className="block text-sm">
            <span className="font-medium text-gray-700">{f.label}</span>
            {typeof f.value === "boolean" ? (
              <select value={String(draft[f.pointer] ?? f.value)} onChange={(e) => setDraft({ ...draft, [f.pointer]: e.target.value === "true" })} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input inputMode="decimal" value={String(draft[f.pointer] ?? f.value)} onChange={(e) => setDraft({ ...draft, [f.pointer]: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            )}
            {f.hint && <span className="mt-0.5 block text-xs text-gray-500">{f.hint}</span>}
          </label>
        ))}
      </div>
      <button onClick={save} disabled={!dirty} className="btn btn-dark mt-3">
        Save changes
      </button>
      {result && <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>{result.text}</p>}
    </div>
  );
}

interface Change {
  id: number;
  surface: string;
  summary: string;
  author: string;
  at: string;
  undone: boolean;
  diff: string[];
}

/** An institution's settings changes, each of which can be undone. */
export function SettingsHistory({ team, surface, onChange }: { team: string; surface: string; onChange: () => void }) {
  const { data, refresh } = useView<{ changes: Change[] }>(team, `/history?surface=${surface}`, 5000);
  const undo = async (id: number) => {
    await api(team, `/history/${id}`, { method: "POST" });
    await refresh();
    onChange();
  };
  if (!data?.changes.length) return <p className="text-sm text-gray-500">No settings have been changed yet.</p>;
  return (
    <ul className="divide-y divide-gray-100 text-sm">
      {data.changes.map((c) => (
        <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
          <div className="min-w-0">
            <div className="text-gray-900">{c.summary}</div>
            <div className="text-xs text-gray-500">
              {when(c.at)} · via {c.author}
            </div>
            <details className="mt-1 text-xs text-gray-600">
              <summary className="cursor-pointer">What changed</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-[11px]">{c.diff.join("\n")}</pre>
            </details>
          </div>
          {c.undone ? <Badge>undone</Badge> : c.summary.startsWith("Undo:") ? null : <button onClick={() => undo(c.id)} className="btn !px-2 !py-1 !text-xs">↶ Undo</button>}
        </li>
      ))}
    </ul>
  );
}

export function Loading({ error }: { error: string | null }) {
  return <p className={`p-8 text-center text-sm ${error ? "text-red-700" : "text-gray-500"}`}>{error ?? "Loading…"}</p>;
}

export const REGIONS = ["Greater Accra", "Ashanti", "Central", "Western", "Western North", "Eastern", "Volta", "Oti", "Northern", "Savannah", "North East", "Upper East", "Upper West", "Bono", "Bono East", "Ahafo"];
export const ID_FIELDS: Field[] = [
  { name: "card", label: "Ghana Card number", placeholder: "GHA-000000000-0" },
  { name: "fingerprint", label: "Fingerprint", placeholder: "FP-XXXXXX", hint: "The customer's fingerprint code, from their Ghana Card record at NIA." },
];
