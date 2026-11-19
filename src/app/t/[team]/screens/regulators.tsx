"use client";

import { useState } from "react";
import { ActionForm, Activity, Badge, Loading, Section, SettingsForm, SettingsHistory, Shell, Stat, Stats, Status, Table, useView, type ActivityRow } from "@/components/ui";
import { ghs, when } from "@/lib/client";

// ---------- Bank of Ghana ----------

interface Tier {
  maxBalance: number;
  daily: number;
  monthly: number | null;
}
interface BogView {
  config: { kycTiers: Record<string, Tier> };
  issuers: { telco: string; name: string; trustBank: string; customerFunds: number; onHold: number; issuerFunds: number; eMoney: number; trustBalance: number; unsettled: number; backed: boolean }[];
  banks: { bank: string; name: string; deposits: number; vaultCash: number; settlementAccount: number; unsettled: number }[];
  wallets: { tier: string; count: number }[];
  ledgerBalanced: boolean;
  activity: ActivityRow[];
}

export function Bog({ team }: { team: string }) {
  const path = "/s/bog";
  const { data, error, refresh } = useView<BogView>(team, path);
  if (!data) return <Loading error={error} />;
  const tiers = data.config.kycTiers;
  return (
    <Shell team={team} title="Bank of Ghana" subtitle="Regulator of banks and e-money issuers" color="#6b1d1d">
      <Stats>
        {data.wallets.map((w) => (
          <Stat key={w.tier} label={`${w.tier} KYC wallets`} value={w.count} />
        ))}
        <Stat label="E-money fully backed" value={data.issuers.every((i) => i.backed) ? "Yes" : "No"} tone={data.issuers.every((i) => i.backed) ? "good" : "bad"} />
        <Stat label="Ledger balanced" value={data.ledgerBalanced ? "Yes" : "No"} tone={data.ledgerBalanced ? "good" : "bad"} sub="every payment adds up to zero" />
      </Stats>

      <Section title="KYC tier limits for mobile money wallets" hint="These apply to every network at once. Minimum: opened from the phone. Medium: verified in person with Ghana Card and fingerprint. Enhanced: medium plus proof of address. All amounts in GHS.">
        <SettingsForm
          team={team}
          path={path}
          onSaved={refresh}
          fields={(["minimum", "medium", "enhanced"] as const).flatMap((t) => [
            { pointer: `/kycTiers/${t}/maxBalance`, label: `${t}: maximum balance`, value: tiers[t].maxBalance },
            { pointer: `/kycTiers/${t}/daily`, label: `${t}: daily sending limit`, value: tiers[t].daily },
            ...(tiers[t].monthly !== null ? [{ pointer: `/kycTiers/${t}/monthly`, label: `${t}: monthly sending limit`, value: tiers[t].monthly as number }] : []),
          ])}
        />
        <p className="mt-2 text-xs text-gray-500">Medium and enhanced wallets have no monthly limit. Agent and merchant wallets are business wallets and are not capped by these tiers.</p>
      </Section>

      <Section title="E-money issuers: is every cedi backed?" hint="A telco may only issue e-money against real money. Its customers' wallets must always equal its trust account at the bank, adjusted for whatever is still waiting to settle through the switch.">
        <Table
          rows={data.issuers}
          empty=""
          cols={[
            { label: "Issuer", cell: (i) => <span className="font-medium text-gray-900">{i.name}</span> },
            { label: "Wallet balances", right: true, cell: (i) => ghs(i.customerFunds) },
            { label: "On hold in disputes", right: true, cell: (i) => (i.onHold ? ghs(i.onHold) : "–") },
            { label: "Issuer's own e-money", right: true, cell: (i) => ghs(i.issuerFunds) },
            { label: "Trust account", right: true, cell: (i) => (<>{ghs(i.trustBalance)}<div className="text-[11px] text-gray-500">{i.trustBank}</div></>) },
            { label: "Waiting to settle", right: true, cell: (i) => (i.unsettled === 0 ? "–" : i.unsettled > 0 ? `owes ${ghs(i.unsettled)}` : `is owed ${ghs(-i.unsettled)}`) },
            { label: "Backed", cell: (i) => (i.backed ? <Badge tone="green">fully backed</Badge> : <Badge tone="red">shortfall</Badge>) },
          ]}
        />
      </Section>

      <Section title="Banks" hint="Each bank's settlement account is where net settlement from the national switch lands. A negative balance means the bank has paid out more than it has received so far.">
        <Table
          rows={data.banks}
          empty=""
          cols={[
            { label: "Bank", cell: (b) => <span className="font-medium text-gray-900">{b.name}</span> },
            { label: "Deposits held", right: true, cell: (b) => ghs(b.deposits) },
            { label: "Cash in vault", right: true, cell: (b) => ghs(b.vaultCash) },
            { label: "Settlement account", right: true, cell: (b) => <span className={b.settlementAccount < 0 ? "text-red-700" : ""}>{ghs(b.settlementAccount)}</span> },
            { label: "Waiting to settle", right: true, cell: (b) => (b.unsettled === 0 ? "–" : b.unsettled > 0 ? `owes ${ghs(b.unsettled)}` : `is owed ${ghs(-b.unsettled)}`) },
          ]}
        />
      </Section>

      <Section title="Rule changes">
        <SettingsHistory team={team} surface="bog" onChange={refresh} />
      </Section>
    </Shell>
  );
}

// ---------- National Communications Authority ----------

interface NcaView {
  config: { maxSimsPerCard: number; minimumAge: number; primaryNumberApproval: boolean };
  networks: { telco: string; name: string; registered: number; blocked: number; deactivated: number; points: number }[];
  registry: { msisdn: string; network: string; status: string; registered_at: string; registered_by: string; ghana_card: string; owner: string; held: number }[];
  activity: ActivityRow[];
}

export function Nca({ team }: { team: string }) {
  const path = "/s/nca";
  const [card, setCard] = useState("");
  const [filter, setFilter] = useState("");
  const { data, error, refresh } = useView<NcaView>(team, `${path}?card=${encodeURIComponent(filter)}`);
  if (!data) return <Loading error={error} />;
  return (
    <Shell team={team} title="National Communications Authority" subtitle="Regulator of the telcos" color="#0f4c81">
      <Stats>
        {data.networks.map((n) => (
          <Stat key={n.telco} label={`${n.name} registered SIMs`} value={n.registered} sub={`${n.blocked} blocked · ${n.points} registration point(s)`} />
        ))}
      </Stats>

      <Section title="SIM registration rules" hint="Every telco's registration points must follow these. They are enforced at the moment a SIM is registered.">
        <SettingsForm
          team={team}
          path={path}
          onSaved={refresh}
          fields={[
            { pointer: "/maxSimsPerCard", label: "Most SIMs one Ghana Card may hold", value: data.config.maxSimsPerCard, hint: "Counted across all networks." },
            { pointer: "/minimumAge", label: "Youngest age to register a SIM", value: data.config.minimumAge },
            { pointer: "/primaryNumberApproval", label: "Extra SIMs need a code from the first number", value: data.config.primaryNumberApproval, hint: "Stops someone adding SIMs to a card without the holder knowing." },
          ]}
        />
      </Section>

      <Section title="Central SIM register" hint="Every registered number on every network, against the Ghana Card it was registered with. Operators report here so the regulator can see across networks.">
        <form
          className="mb-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(card.trim());
          }}
        >
          <input value={card} onChange={(e) => setCard(e.target.value)} placeholder="Find by Ghana Card number" className="min-w-[220px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button className="btn btn-dark">Search</button>
          {filter && (
            <button type="button" className="btn" onClick={() => { setCard(""); setFilter(""); }}>
              Show all
            </button>
          )}
        </form>
        <Table
          rows={data.registry}
          empty={filter ? "No numbers are registered to that Ghana Card." : "No SIM has been registered on any network yet."}
          cols={[
            { label: "Number", cell: (r) => <span className="font-mono text-xs">{r.msisdn}</span> },
            { label: "Network", cell: (r) => r.network },
            { label: "Registered to", cell: (r) => r.owner },
            { label: "Ghana Card", cell: (r) => <span className="font-mono text-xs">{r.ghana_card}</span> },
            { label: "SIMs on this card", right: true, cell: (r) => <span className={r.held >= data.config.maxSimsPerCard ? "font-semibold text-red-700" : ""}>{r.held}</span> },
            { label: "Registered", cell: (r) => (<><span className="whitespace-nowrap">{when(r.registered_at)}</span><div className="text-[11px] text-gray-500">at {r.registered_by}</div></>) },
            { label: "Status", cell: (r) => <Status value={r.status} /> },
          ]}
        />
      </Section>

      <Section title="Order a number blocked" hint="The regulator directs the operator to take a number off its network, for example when its registration is found to be invalid. The operator must comply.">
        <ActionForm team={team} path={path} action="order_block" submit="Issue directive" onDone={refresh} fields={[{ name: "msisdn", label: "Number", placeholder: "Any network" }, { name: "reason", label: "Reason", optional: true }]} />
      </Section>

      <Section title="Rule changes and directives">
        <SettingsHistory team={team} surface="nca" onChange={refresh} />
        <div className="mt-3">
          <Activity rows={data.activity.filter((a) => !a.summary.includes("→"))} empty="No directives issued." />
        </div>
      </Section>
    </Shell>
  );
}
