"use client";

import Link from "next/link";
import { TelcoMark } from "@/components/telco-mark";
import { Loading, Section, Shell, Stat, Stats, useView } from "@/components/ui";
import { ghs } from "@/lib/client";
import { NetworkSwitch, TEXT_ON } from "./agents";

interface TelcoSummary {
  brand: { name: string; wallet: string; color: string; shortcode: string; logo: string | null };
  stats: { simsInStock: number; simsActive: number; wallets: number; agents: number; merchants: number; eMoney: number; openTickets: number };
  simAgents: unknown[];
}

/** One network's front door: everything that network runs, in one place. Reached from the Telcos menu. */
export default function TelcoHome({ team, telco }: { team: string; telco: string }) {
  const { data, error } = useView<TelcoSummary>(team, `/s/telco/${telco}`, 10000);
  if (!data) return <Loading error={error} />;
  const b = data.brand;
  const s = data.stats;
  const base = `/t/${team}`;
  const places: { href: string; title: string; sub: string; stat: string; primary?: boolean }[] = [
    { href: `${base}/telco/${telco}`, title: `${b.name} back office`, sub: "SIM stock, registration points, wallets, agents, merchants, transactions, calls, texts, services, fees, menus, API partners and plug-ins.", stat: `${s.simsActive} active SIM(s) · ${s.wallets} wallet(s) · ${ghs(s.eMoney)} e-money`, primary: true },
    { href: `${base}/sim-agent/${telco}`, title: "SIM registration point", sub: `Register a SIM against a Ghana Card and fingerprint, replace a SIM, reset a ${b.wallet} PIN, raise KYC. ${b.name} Head Office is open from the start.`, stat: `${Math.max(data.simAgents.length, 1)} registration point(s) · ${s.simsInStock} blank SIM(s) in stock` },
    { href: `${base}/momo-agent/${telco}`, title: "Mobile money agent", sub: `Open an agent from the owner's Ghana Card, then cash-in, cash-out and open ${b.wallet} wallets for customers.`, stat: `${s.agents} agent(s) · ${s.merchants} merchant(s)` },
    { href: `${base}/care/${telco}`, title: "Customer care", sub: "Complaints, wrong transfers, blocked lines and locked wallets.", stat: `${s.openTickets} open ticket(s)` },
  ];

  return (
    <Shell team={team} title={b.name} subtitle={`${b.wallet} · dial ${b.shortcode}`} color={b.color} textOn={TEXT_ON[telco]} mark={<TelcoMark telco={telco} logo={b.logo} height={34} />} right={<NetworkSwitch team={team} kind="telcos" telco={telco} />}>
      <Stats>
        <Stat label="Active SIMs" value={s.simsActive} sub={`${s.simsInStock} blank in stock`} />
        <Stat label={`${b.wallet} wallets`} value={s.wallets} />
        <Stat label="Agents and merchants" value={s.agents + s.merchants} sub={`${s.agents} agent(s) · ${s.merchants} merchant(s)`} />
        <Stat label="E-money in wallets" value={ghs(s.eMoney)} />
      </Stats>
      <Section title={`Everything ${b.name} runs`}>
        <div className="grid gap-3 md:grid-cols-2">
          {places.map((p) => (
            <Link key={p.href} href={p.href} className="card flex flex-col overflow-hidden hover:shadow-md">
              <div className="h-1.5" style={{ background: b.color }} />
              <div className="flex flex-1 flex-col p-4">
                <div className="font-semibold text-gray-900">{p.title}</div>
                <div className="mt-0.5 text-sm text-gray-600">{p.sub}</div>
                <div className="mt-auto pt-3 text-sm text-gray-700">{p.stat}</div>
              </div>
            </Link>
          ))}
        </div>
      </Section>
    </Shell>
  );
}
