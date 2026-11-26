"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { InnofemmeLogo } from "@/components/brand";
import { TelcoMark } from "@/components/telco-mark";
import { Activity, Loading, useView, type ActivityRow } from "@/components/ui";
import { api, teamName, when } from "@/lib/client";
import { Select } from "@/components/select";
import { ChevronDown } from "lucide-react";
import { askConfirm } from "@/stores/ui";

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

const TELCO_COLOR: Record<string, string> = { mtn: "#ffcb05", telecel: "#e60000", at: "#1f3c88" };

export default function Hub({ team, logos, phones, consoles }: { team: string; logos: Record<string, string | null>; phones: PhoneCode[]; consoles?: PhoneCode & { key: string } }) {
  const { data, error, refresh } = useView<HubView>(team, "/s/hub", 4000);
  const base = `/t/${team}`;
  const next = data?.steps.find((s) => !s.done);
  const done = data?.steps.filter((s) => s.done).length ?? 0;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <InnofemmeLogo size={36} />
          <div className="mr-auto leading-tight">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">Mobile money sandbox</div>
            <h1 className="text-lg font-semibold text-gray-900">{teamName(team)}</h1>
          </div>
          <div className="flex gap-2">
            <Link href={`${base}/developer`} className="btn btn-dark">
              Developer
            </Link>
            <Link href={`${base}/assistant`} className="btn">
              Assistant
            </Link>
            <Link href={`${base}/docs`} className="btn">
              <span className="sm:hidden">Docs</span>
              <span className="hidden sm:inline">Documentation</span>
            </Link>
          </div>
        </div>
      </header>
      {/* Stays at the top while the page scrolls, so every system is one click away from anywhere on it. */}
      <nav aria-label="Systems" className="relative z-30 bg-[#3b1f6e] text-white shadow-sm md:sticky md:top-0">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-1 px-2 py-1.5 sm:px-3">
            <span className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-semibold">Home</span>
            <NavMenu label="Telcos" items={TELCOS.map(([id, name, wallet]) => ({ href: `${base}/telcos/${id}`, title: name, sub: `${wallet} · back office, SIMs, agents, care`, icon: <TelcoMark telco={id} logo={logos[id]} height={26} /> }))} />
            <NavLink href={`${base}/nia`}>NIA</NavLink>
            <NavMenu
              label="Regulators"
              items={[
                { href: `${base}/nca`, title: "NCA", sub: "SIM registration rules and the central register" },
                { href: `${base}/bog`, title: "Bank of Ghana", sub: "KYC limits and oversight of e-money" },
              ]}
            />
            <NavMenu label="Banks" items={BANKS.map(([id, name]) => ({ href: `${base}/bank/${id}`, title: name, sub: "Accounts, cash, transfers, agent float" }))} />
            <NavLink href={`${base}/switch`}>National switch</NavLink>
            <NavLink href={`${base}/phone`}>Phone</NavLink>
            <NavLink href={`${base}/fraud`}>Fraud console</NavLink>
          </div>
      </nav>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {!data ? (
          <Loading error={error} />
        ) : (
          <>
            <p className="mb-4 max-w-3xl text-sm text-gray-600">
              Your team&apos;s own copy of the country&apos;s mobile money systems. Each institution has its own console, and they work together the way the real ones do. Start quickly with one of these:
            </p>
            <div className="mb-8 grid gap-4 lg:grid-cols-2">
              <TestCustomer team={team} onChange={refresh} />
              <SimulatedData team={team} onChange={refresh} />
            </div>

            <SectionTitle title="Building your world" note={`${done} of ${data.steps.length} done`} />
            <ol className="mb-8 grid gap-2 md:grid-cols-2">
              {data.steps.map((s, i) => (
                <li key={s.title}>
                  <Link href={`${base}/${STEP_LINK[s.system]}`} className={`flex h-full gap-3 rounded-xl border bg-white p-3 hover:border-gray-300 hover:shadow-sm ${s === next ? "border-[#3b1f6e] ring-1 ring-[#3b1f6e]" : "border-gray-200"}`}>
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${s.done ? "bg-green-600 text-white" : s === next ? "bg-[#3b1f6e] text-white" : "bg-gray-200 text-gray-600"}`}>{s.done ? "✓" : i + 1}</span>
                    <span>
                      <span className="block text-sm font-medium text-gray-900">
                        {s.title}
                        {s === next && <span className="ml-2 rounded-full bg-[#3b1f6e] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Next</span>}
                      </span>
                      <span className="block text-xs text-gray-600">{s.detail}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>

            <SectionTitle title="Systems" />
            <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {TELCOS.map(([id, name, wallet]) => (
                <Tile key={id} href={`${base}/telcos/${id}`} color={TELCO_COLOR[id]} icon={<TelcoMark telco={id} logo={logos[id]} height={28} />} title={name} sub={`${wallet}: back office, SIM registration, agents and customer care`} />
              ))}
              <Tile href={`${base}/nia`} color="#0b6b3a" title="NIA" sub="Issues Ghana Cards and answers identity checks" stat={`${data.counts.persons} card(s) issued`} />
              <Tile href={`${base}/nca`} color="#0f4c81" title="NCA" sub="SIM registration rules and the central register" stat={`${data.counts.simsRegistered} registered SIM(s)`} />
              <Tile href={`${base}/bog`} color="#6b1d1d" title="Bank of Ghana" sub="KYC limits and oversight of e-money" stat={`${data.counts.wallets} customer wallet(s)`} />
              <Tile href={`${base}/phone`} color="#111827" title="Phone" sub="Use any registered SIM: dial, messages, wallet" stat={`${data.counts.simsRegistered} line(s)`} />
              <Tile href={`${base}/bank/gcb`} color="#7c5a10" title="Banks" sub={`${BANKS.length} banks: accounts, cash, transfers and agent float`} stat={`${data.counts.bankAccounts} personal account(s)`} />
              <Tile href={`${base}/switch`} color="#312e81" title="National switch" sub="Routes payments between networks and banks, and settles" stat={`${data.counts.crossNetwork} payment(s) routed`} />
              <Tile
                href={`${base}/fraud`}
                color="#7f1d1d"
                title="Fraud console"
                sub="Send fraud incidents at your API or application and see how many it stops"
                stat={data.fraud ? `${data.fraud.stopped + data.fraud.contained} of ${data.fraud.incidents} stopped in the last run` : "Nothing run yet"}
              />
            </div>

            {phones.length > 0 && <PhoneCodes phones={phones} consoles={consoles} />}

            <div className="grid items-start gap-4 lg:grid-cols-3">
              <section className="card p-4 lg:col-span-2">
                <h2 className="mb-2 font-semibold text-gray-900">Recent activity</h2>
                <Activity rows={data.activity} showSystem pageSize={8} pageSizes={[5, 8, 10, 20, 40]} empty="Nothing yet. Start at NIA: issue the first Ghana Card." />
              </section>
              <WorldTools team={team} onChange={refresh} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {note && <span className="text-xs text-gray-500">{note}</span>}
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
    <section className="card mb-8 p-5">
      <h2 className="font-semibold text-gray-900">Open on a phone</h2>
      <p className="mt-1 max-w-3xl text-sm text-gray-600">
        Point a phone&apos;s camera at a code. The customer code opens only the phone; the agent code opens only the agent screens. Neither reaches the consoles, so they are safe to show on a projector.
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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 hover:text-white">
      {children}
    </Link>
  );
}

/** A menu in the navigation bar: opens a list of places, closes on a click elsewhere or Escape. */
function NavMenu({ label, items }: { label: string; items: { href: string; title: string; sub?: string; icon?: React.ReactNode }[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className={`rounded-lg px-3 py-1.5 text-sm font-medium ${open ? "bg-white text-[#3b1f6e]" : "text-white/90 hover:bg-white/10 hover:text-white"}`}>
        <span className="flex items-center gap-1">{label} <ChevronDown aria-hidden className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} /></span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-30 mt-1.5 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 text-gray-900 shadow-xl">
          {items.map((it) => (
            <Link key={it.href} role="menuitem" href={it.href} onClick={() => setOpen(false)} className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50">
              {it.icon}
              <span className="leading-tight">
                <span className="block text-sm font-medium">{it.title}</span>
                {it.sub && <span className="block text-xs text-gray-500">{it.sub}</span>}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ href, color, title, sub, stat, icon }: { href: string; color: string; title: string; sub: string; stat?: string; icon?: React.ReactNode }) {
  return (
    <Link href={href} className="card group flex flex-col overflow-hidden hover:border-gray-300 hover:shadow-md">
      <div className="h-1" style={{ background: color }} />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-3">
          {icon}
          <div className="font-semibold text-gray-900">{title}</div>
          <span aria-hidden className="ml-auto text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-500">→</span>
        </div>
        <div className="mt-1 text-sm text-gray-600">{sub}</div>
        {stat && <div className="mt-auto pt-3 text-xs font-medium text-gray-500">{stat}</div>}
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
        <button type="button" className="btn btn-danger" onClick={async () => (await askConfirm({ title: "Wipe this world?", message: "It goes back to an empty country. Everything your team has built will be lost, unless you saved it first.", confirm: "Wipe the world", danger: true })) && run(() => api(team, "/world", { body: { action: "reset" } }), "World reset to empty.")}>
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
              <button className="btn !px-2 !py-1 !text-xs" onClick={async () => (await askConfirm({ title: `Roll back to "${s.label}"?`, message: "The whole world goes back to how it was at this save point. Anything done since is lost.", confirm: "Roll back", danger: true })) && run(() => api(team, `/snapshots/${s.id}`, { method: "POST" }), `Rolled back to "${s.label}".`)}>
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

interface Customer {
  name: string;
  ghanaCard: string;
  fingerprint: string;
  number: string;
  network: string;
  networkName: string;
  walletCode: string;
  pin: string;
  balance: number;
}

/** A customer to try things with, without building one by hand: a person, a registered number and a funded wallet whose PIN is shown. */
function TestCustomer({ team, onChange }: { team: string; onChange: () => void }) {
  const [network, setNetwork] = useState("mtn");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [made, setMade] = useState<Customer[]>([]);
  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ customer: Customer }>(team, "/s/hub", { body: { action: "test_customer", network } });
      setMade((m) => [r.customer, ...m]);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <QuickCard
      title="Create a test customer"
      text="A new person with a Ghana Card, a registered number and a wallet holding GHS 500. You see their PIN once, so you can dial from their phone straight away."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-44" value={network} onChange={setNetwork} label="Network" options={TELCOS.map(([id, name, wallet]) => ({ value: id, label: name, hint: wallet }))} />
        <button className="btn btn-dark" disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create a test customer"}
        </button>
        {msg && <span className="text-sm text-red-700">{msg}</span>}
      </div>
      {made.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100 text-sm">
          {made.map((c) => (
            <li key={c.number} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
              <span>
                <span className="font-medium text-gray-900">{c.name}</span> · {c.networkName} <span className="font-mono">{c.number}</span> · wallet PIN <span className="font-mono font-semibold">{c.pin}</span> · GHS {c.balance.toFixed(2)}
                <span className="block text-xs text-gray-500">
                  Ghana Card <span className="font-mono">{c.ghanaCard}</span> · fingerprint <span className="font-mono">{c.fingerprint}</span> · dial <span className="font-mono">{c.walletCode}</span>
                </span>
              </span>
              {/* The phone page opens on the number this browser last chose. */}
              <Link href={`/t/${team}/phone`} onClick={() => localStorage.setItem(`phone:${team}`, c.number)} className="btn !py-1 !text-xs">
                Open this phone
              </Link>
            </li>
          ))}
        </ul>
      )}
    </QuickCard>
  );
}

/** One of the two ways to get started, side by side at the top of the page. */
function QuickCard({ title, text, children }: { title: string; text: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col p-5">
      <h2 className="font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{text}</p>
      <div className="mt-auto pt-4">{children}</div>
    </section>
  );
}

/** A ready-made country with three months of history, a known share of it fraud, to load in place of the empty world. */
function SimulatedData({ team, onChange }: { team: string; onChange: () => void }) {
  const { data, refresh } = useView<DatasetView>(team, "/dataset", 15000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    if (!(await askConfirm({ title: "Load the simulated country?", message: "It replaces what is in this world. What your team has built so far is kept as a save point, so you can roll back to it.", confirm: "Load it" }))) return;
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
  if (!data?.loaded || !s) {
    return (
      <QuickCard
        title="Load the simulated country"
        text="Swap this empty world for a ready-made one: thousands of people, SIMs, wallets, agents and bank accounts, with three months of transactions, some of them labelled fraud."
      >
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-dark" disabled={busy} onClick={load}>
            {busy ? "Loading…" : "Load the simulated country"}
          </button>
          {msg && <span className="text-sm text-gray-700">{msg}</span>}
        </div>
      </QuickCard>
    );
  }
  return (
    <QuickCard
      title="Simulated country loaded"
      text={
        <>
          <b>{num(s.transactions)}</b> transactions from {when(s.from).slice(0, 6)} to {when(s.to).slice(0, 6)}, <b>{Math.round((s.fraud / s.transactions) * 100)}%</b> of them fraud in {num(s.cases)} cases, across {num(s.people)} people and {num(s.wallets)} wallets. What you do now is
          added on top.
        </>
      }
    >
      <details>
        <summary className="cursor-pointer text-sm font-medium text-gray-800">The fraud in it, and downloads</summary>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">The fraud in it</h3>
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
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Download it</h3>
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
      </details>
      {msg && <p className="mt-2 text-sm text-gray-700">{msg}</p>}
    </QuickCard>
  );
}
