"use client";

import Link from "next/link";
import { useState } from "react";
import { InnofemmeLogo } from "@/components/brand";
import { TelcoMark } from "@/components/telco-mark";
import { Activity, Loading, useView, type ActivityRow } from "@/components/ui";
import { api, teamName, when } from "@/lib/client";

interface HubView {
  counts: Record<string, number>;
  steps: { system: string; title: string; detail: string; done: boolean }[];
  activity: ActivityRow[];
  fraud: { incidents: number; stopped: number; contained: number } | null;
}

const BANKS: [string, string][] = [["gcb", "GCB Bank"], ["ecobank", "Ecobank Ghana"], ["fidelity", "Fidelity Bank"], ["calbank", "CalBank"], ["absa", "Absa Bank Ghana"], ["stanbic", "Stanbic Bank"]];
const TELCOS: [string, string, string][] = [["mtn", "MTN", "MTN MoMo"], ["telecel", "Telecel", "Telecel Cash"], ["at", "AT", "AT Money"]];
const STEP_LINK: Record<string, string> = { nia: "nia", telco: "telco/mtn", "sim-agent": "sim-agent/mtn", "momo-agent": "momo-agent/mtn", bank: "bank/gcb", phone: "phone", switch: "switch" };

interface PhoneCode {
  role: string;
  title: string;
  hint: string;
  url: string;
  qr: string;
}

export default function Hub({ team, logos, phones, consoles }: { team: string; logos: Record<string, string | null>; phones: PhoneCode[]; consoles?: PhoneCode & { key: string } }) {
  const { data, error, refresh } = useView<HubView>(team, "/s/hub", 4000);
  const base = `/t/${team}`;
  const next = data?.steps.find((s) => !s.done);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <InnofemmeLogo size={36} />
          <div className="mr-auto leading-tight">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">Mobile money sandbox</div>
            <h1 className="text-lg font-semibold text-gray-900">{teamName(team)}: choose a system</h1>
          </div>
          <Link href={`${base}/docs`} className="btn">
            API for coders
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        <p className="mb-5 max-w-3xl text-sm text-gray-600">
          This is your team&apos;s own copy of the country&apos;s mobile money systems. It starts empty: no people, no SIM cards, no money. Each institution below has its own console, and they only work together the way the real ones do.
        </p>

        {!data ? (
          <Loading error={error} />
        ) : (
          <>
            <section className="card mb-5 p-4">
              <h2 className="font-semibold text-gray-900">Building your world</h2>
              <ol className="mt-3 grid gap-2 md:grid-cols-2">
                {data.steps.map((s, i) => (
                  <li key={s.title}>
                    <Link href={`${base}/${STEP_LINK[s.system]}`} className={`flex h-full gap-3 rounded-lg border p-3 hover:bg-gray-50 ${s === next ? "border-[#3b1f6e] bg-[#f3effa]" : "border-gray-200"}`}>
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${s.done ? "bg-green-600 text-white" : s === next ? "bg-[#3b1f6e] text-white" : "bg-gray-200 text-gray-600"}`}>{s.done ? "✓" : i + 1}</span>
                      <span>
                        <span className="block text-sm font-medium text-gray-900">{s.title}</span>
                        <span className="block text-xs text-gray-600">{s.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>

            {phones.length > 0 && <PhoneCodes phones={phones} consoles={consoles} />}

            <Group title="Testing what you have built">
              <Tile
                href={`${base}/fraud`}
                color="#7f1d1d"
                title="Fraud console"
                sub="Send fraud incidents at your API or application, and see how many it stops"
                stat={data.fraud ? `Fraud API results: ${data.fraud.stopped + data.fraud.contained} of ${data.fraud.incidents} stopped in the last run` : "Fraud API results: nothing run yet"}
              />
            </Group>

            <Group title="Identity and regulators">
              <Tile href={`${base}/nia`} color="#0b6b3a" title="NIA" sub="Ghana Card register" stat={`${data.counts.persons} card(s) issued`} />
              <Tile href={`${base}/nca`} color="#0f4c81" title="NCA" sub="SIM registration rules and central register" stat={`${data.counts.simsRegistered} registered SIM(s)`} />
              <Tile href={`${base}/bog`} color="#6b1d1d" title="Bank of Ghana" sub="KYC limits and oversight of e-money" stat={`${data.counts.wallets} customer wallet(s)`} />
            </Group>

            <Group title="Telcos">
              {TELCOS.map(([id, name, wallet]) => (
                <div key={id} className="card flex flex-col p-4">
                  <div className="flex items-center gap-3">
                    <TelcoMark telco={id} logo={logos[id]} height={34} />
                    <div>
                      <div className="font-semibold text-gray-900">{name}</div>
                      <div className="text-xs text-gray-500">{wallet}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2">
                    <Link href={`${base}/telco/${id}`} className="btn btn-dark justify-center">
                      {name} back office
                    </Link>
                    <Link href={`${base}/care/${id}`} className="btn justify-center">
                      Customer care
                    </Link>
                    <Link href={`${base}/sim-agent/${id}`} className="btn justify-center">
                      SIM registration point
                    </Link>
                    <Link href={`${base}/momo-agent/${id}`} className="btn justify-center">
                      Mobile money agent
                    </Link>
                  </div>
                </div>
              ))}
            </Group>

            <Group title="People, banks and the national switch">
              <Tile href={`${base}/phone`} color="#111827" title="Phone" sub="Any registered SIM: dial, messages, wallet" stat={`${data.counts.simsRegistered} line(s)`} />
              <div className="card p-4">
                <div className="font-semibold text-gray-900">Banks</div>
                <div className="text-xs text-gray-500">Accounts, cash, transfers, agent float</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {BANKS.map(([id, name]) => (
                    <Link key={id} href={`${base}/bank/${id}`} className="btn justify-center !text-xs">
                      {name}
                    </Link>
                  ))}
                </div>
              </div>
              <Tile href={`${base}/switch`} color="#312e81" title="National switch" sub="Routing between networks and banks, settlement" stat={`${data.counts.crossNetwork} payment(s) routed`} />
            </Group>

            <section className="card mb-5 p-4">
              <h2 className="mb-2 font-semibold text-gray-900">What has happened, across all systems</h2>
              <Activity rows={data.activity} showSystem empty="Nothing yet. Start at NIA: issue the first Ghana Card." />
            </section>

            <SimulatedData team={team} onChange={refresh} />
        <WorldTools team={team} onChange={refresh} />
          </>
        )}
      </main>
    </div>
  );
}

/** How other devices join: a phone as a customer's or an agent's phone, another laptop as a second console. Any number can be open at once. */
function PhoneCodes({ phones, consoles }: { phones: PhoneCode[]; consoles?: PhoneCode & { key: string } }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showConsoles, setShowConsoles] = useState(false);
  const card = (p: PhoneCode, extra?: React.ReactNode) => (
    <div key={p.role} className="flex items-center gap-4 rounded-lg border border-gray-200 p-3">
      <div className="w-[150px] shrink-0" dangerouslySetInnerHTML={{ __html: p.qr }} />
      <div className="min-w-0">
        <div className="font-semibold text-gray-900">{p.title}</div>
        <div className="text-sm text-gray-600">{p.hint}</div>
        {extra}
        <button
          className="mt-2 text-xs underline"
          onClick={() => {
            void navigator.clipboard?.writeText(p.url);
            setCopied(p.role);
          }}
        >
          {copied === p.role ? "Link copied" : "Copy link instead"}
        </button>
      </div>
    </div>
  );
  return (
    <section className="card mb-5 p-4">
      <h2 className="font-semibold text-gray-900">Open on another device</h2>
      <p className="mt-0.5 max-w-3xl text-sm text-gray-600">
        Any number of devices can be open at once: this page stays as it is while a phone is used as a customer&apos;s or an agent&apos;s phone. Point the phone&apos;s camera at a code. The customer code opens only the phone simulator; the agent code opens only the
        agent screens. Neither can reach the consoles, so they are safe to show on a projector.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{phones.map((p) => card(p))}</div>
      {consoles && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <button className="text-sm font-medium text-gray-900 underline" onClick={() => setShowConsoles(!showConsoles)}>
            {showConsoles ? "Hide the code for the consoles" : "Open these consoles on another laptop or tablet"}
          </button>
          {showConsoles && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {card(
                { ...consoles, title: "The consoles (this page)", hint: "Opens every system, like this device. Only for your own team: do not show it on a projector." },
                <div className="mt-1 text-xs text-gray-600">
                  Team key: <span className="select-all break-all font-mono text-gray-900">{consoles.key}</span>
                </div>,
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="grid gap-3 md:grid-cols-3">{children}</div>
    </section>
  );
}

function Tile({ href, color, title, sub, stat }: { href: string; color: string; title: string; sub: string; stat: string }) {
  return (
    <Link href={href} className="card flex flex-col overflow-hidden hover:shadow-md">
      <div className="h-1.5" style={{ background: color }} />
      <div className="flex flex-1 flex-col p-4">
        <div className="font-semibold text-gray-900">{title}</div>
        <div className="text-xs text-gray-500">{sub}</div>
        <div className="mt-auto pt-3 text-sm text-gray-700">{stat}</div>
      </div>
    </Link>
  );
}

function WorldTools({ team, onChange }: { team: string; onChange: () => void }) {
  const { data, refresh } = useView<{ snapshots: { id: string; label: string; createdAt: number }[] }>(team, "/snapshots", 8000);
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setMsg(done);
      await refresh();
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="card p-4">
      <h2 className="font-semibold text-gray-900">Save points</h2>
      <p className="mt-0.5 text-sm text-gray-600">Save the whole world before trying something risky, and roll back if it goes wrong.</p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api(team, "/snapshots", { body: { label: label || "Save point" } }), "Saved.").then(() => setLabel(""));
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this save point" className="min-w-[200px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <button className="btn btn-dark">Save now</button>
        <button type="button" className="btn btn-danger" onClick={() => confirm("Wipe this world back to an empty country? Everything your team has built will be lost.") && run(() => api(team, "/world", { body: { action: "reset" } }), "World reset to empty.")}>
          Reset to empty
        </button>
      </form>
      {msg && <p className="mt-2 text-sm text-gray-700">{msg}</p>}
      {!!data?.snapshots.length && (
        <ul className="mt-3 divide-y divide-gray-100 text-sm">
          {data.snapshots.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {s.label} <span className="text-xs text-gray-500">· {when(new Date(s.createdAt).toISOString())}</span>
              </span>
              <button className="btn !px-2 !py-1 !text-xs" onClick={() => confirm(`Roll the whole world back to "${s.label}"?`) && run(() => api(team, `/snapshots/${s.id}`, { method: "POST" }), `Rolled back to "${s.label}".`)}>
                Roll back
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DatasetView {
  loaded: boolean;
  summary?: { transactions: number; fraud: number; legitimate: number; failed: number; cases: number; from: string; to: string; people: number; sims: number; wallets: number; agents: number; merchants: number; bankAccounts: number; texts: number; calls: number; complaints: number };
  scenarios?: { id: string; about: string; transactions: number; cases: number }[];
  files?: { name: string; about: string; rows: number; url: string }[];
}
const num = (n: number) => n.toLocaleString("en");

/** A ready-made country with three months of history, a known share of it fraud, to load in place of the empty world. */
function SimulatedData({ team, onChange }: { team: string; onChange: () => void }) {
  const { data, refresh } = useView<DatasetView>(team, "/dataset", 15000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    if (!confirm("Replace this world with the simulated country? What your team has built so far is kept as a save point, so you can roll back to it.")) return;
    setBusy(true);
    setMsg("Loading the simulated country. This can take up to a minute the first time…");
    try {
      await api(team, "/world", { body: { action: "simulate" } });
      setMsg("Loaded.");
      await refresh();
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = data?.summary;
  return (
    <section className="card mb-5 p-4">
      <h2 className="font-semibold text-gray-900">Simulated data</h2>
      {!data?.loaded || !s ? (
        <>
          <p className="mt-0.5 text-sm text-gray-600">
            Your world starts empty. Instead of building everything by hand, you can load a ready-made country: thousands of people with Ghana Cards, their SIMs, wallets, agents, merchants and bank accounts, and three months of transactions between them.
            A known share of those transactions are fraud of ten different kinds, each labelled, so there is something to study, detect and test against.
          </p>
          <button className="btn btn-dark mt-3" disabled={busy} onClick={load}>
            {busy ? "Loading…" : "Load the simulated country"}
          </button>
        </>
      ) : (
        <>
          <p className="mt-0.5 text-sm text-gray-600">
            This world holds a simulated country: <b>{num(s.transactions)}</b> transactions from {when(s.from).slice(0, 6)} to {when(s.to).slice(0, 6)}, of which <b>{num(s.fraud)}</b> ({Math.round((s.fraud / s.transactions) * 100)}%) are fraud in {num(s.cases)} cases.
            {" "}{num(s.people)} people, {num(s.sims)} registered numbers, {num(s.wallets)} wallets, {num(s.agents)} agents, {num(s.merchants)} merchants, {num(s.bankAccounts)} bank accounts, {num(s.calls)} calls, {num(s.texts)} texts and {num(s.complaints)} complaints. Everything
            you do from here is added on top of it.
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">The fraud in it</h3>
              <ul className="mt-1 divide-y divide-gray-100 text-sm">
                {data.scenarios?.map((x) => (
                  <li key={x.id} className="flex items-start justify-between gap-3 py-1.5">
                    <span>
                      <span className="font-mono text-xs text-gray-900">{x.id}</span>
                      <span className="block text-xs text-gray-600">{x.about}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-gray-700">
                      {num(x.transactions)} transactions
                      <span className="block text-gray-500">{num(x.cases)} cases</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Download it</h3>
              <ul className="mt-1 divide-y divide-gray-100 text-sm">
                {data.files?.map((f) => (
                  <li key={f.name} className="flex items-start justify-between gap-3 py-1.5">
                    <span>
                      <a className="font-mono text-xs underline" href={`/api/w/${team}/dataset/${f.name}`}>
                        {f.name}
                      </a>
                      <span className="block text-xs text-gray-600">{f.about}</span>
                    </span>
                    <span className="shrink-0 text-xs text-gray-500">{num(f.rows)} rows</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                transactions.csv says which transactions are fraud. Add <code>?answers=0</code> to its address to get it without those columns.
              </p>
            </div>
          </div>
        </>
      )}
      {msg && <p className="mt-2 text-sm text-gray-700">{msg}</p>}
    </section>
  );
}
