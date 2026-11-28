"use client";

import Link from "next/link";
import { useState } from "react";
import { TelcoMark } from "@/components/telco-mark";
import { ActionButton, ActionForm, Activity, Badge, Loading, Section, SettingsForm, SettingsHistory, SettingsJson, Shell, Stat, Stats, Status, Table, Tabs, TxnTable, useView, type ActivityRow, type TxnRow } from "@/components/ui";
import { ghs, when } from "@/lib/client";
import { OpenAgentForm } from "./agents";
import { ApiPartners, type ApiPartner } from "./partners";
import { Plugins, type PluginView } from "./plugins";

interface TelcoView {
  telco: string;
  brand: { name: string; wallet: string; color: string; shortcode: string; logo: string | null };
  stats: { simsInStock: number; simsActive: number; simsBlocked: number; wallets: number; agents: number; merchants: number; eMoney: number; revenue: number; airtimeSales: number; owedToBillers: number; onHold: number; openTickets: number; trustBalance: number; trustBank: string; switchPosition: number };
  stock: { msisdn: string; iccid: string }[];
  sims: { msisdn: string; iccid: string; status: string; owner: string; card: string; registeredAt: string; registeredBy: string; lastSwapAt: string | null; blockReason: string | null; hasWallet: boolean }[];
  simAgents: { id: string; name: string; kind: string; town: string; status: string; owner: string; registered: number }[];
  wallets: { msisdn: string; name: string; type: string; tier: string; status: string; balance: number; card: string; openedAt: string }[];
  momoAgents: { code: string; name: string; town: string; msisdn: string; float: number; cash: number; commission: number; status: string }[];
  merchants: { till: string; name: string; category: string; town: string; msisdn: string; balance: number }[];
  txns: TxnRow[];
  calls: { id: string; at: string; from: string; to: string; fromNetwork: string; toNetwork: string; status: string; reason: string | null; seconds: number }[];
  sms: { id: number; at: string; kind: string; from: string; fromNetwork: string; to: string; toNetwork: string; parts: number; status: string; reason: string | null }[];
  apiPartners: ApiPartner[];
  services: { cashOut: string; bundles: { id: string; name: string; price: number; mb: number; days: number }[]; billers: { id: string; name: string; ask: string; token?: boolean }[]; atmBanks: string[]; registration: { code?: string; pinBySms?: boolean } };
  bills: { id: string; at: string; biller: string; account: string; amount: number; token: string | null; from: string }[];
  plugins: PluginView["plugins"];
  pluginPoints: PluginView["pluginPoints"];
  pluginEvents: PluginView["pluginEvents"];
  pluginCalls: PluginView["pluginCalls"];
  shortCodes: { code: string; owner: string; url: string; allocatedAt: string; networks: string[]; on: boolean }[];
  simEvents: { id: number; msisdn: string; at: string; kind: string; by: string; detail: string }[];
  activity: ActivityRow[];
  config: {
    menu: unknown;
    fees: unknown;
    agentCommission: unknown;
    notifications: unknown;
    pinAttemptsBeforeLock: number;
    approvalMinutes: number;
    simSwapMomoHoldHours: number;
    selfRegistration: boolean;
    ownBankAccountFree?: boolean;
  };
  limits: Record<string, { maxBalance: number; daily: number; monthly: number | null }>;
}

const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };
const TABS = [["overview", "Overview"], ["sims", "SIMs"], ["points", "SIM registration points"], ["wallets", "Wallets"], ["agents", "Mobile money agents"], ["merchants", "Merchants"], ["txns", "Transactions"], ["calls", "Calls"], ["sms", "SMS"], ["services", "Services"], ["api", "API partners"], ["plugins", "Plug-ins"], ["settings", "Settings"]] as const;
type Tab = (typeof TABS)[number][0];

export default function TelcoConsole({ team, telco }: { team: string; telco: string }) {
  const path = `/s/telco/${telco}`;
  const { data, error, refresh } = useView<TelcoView>(team, path);
  const [tab, setTab] = useState<Tab>("overview");
  if (!data) return <Loading error={error} />;
  const b = data.brand;
  const s = data.stats;
  const businessLine = `An active ${b.name} line registered to the owner, with no wallet on it yet. Register one at a SIM registration point first.`;

  return (
    <Shell team={team} title={`${b.name} back office`} subtitle={`${b.wallet} and SIM management`} color={b.color} textOn={TEXT_ON[telco]} mark={<TelcoMark telco={telco} logo={b.logo} height={34} />}>
      <Stats>
        <Stat label="Active SIMs" value={s.simsActive} sub={`${s.simsInStock} blank in stock · ${s.simsBlocked} blocked`} />
        <Stat label="Customer wallets" value={s.wallets} sub={`${s.agents} agent(s) · ${s.merchants} merchant(s)`} />
        <Stat label="E-money in wallets" value={ghs(s.eMoney)} sub={s.onHold ? `${ghs(s.onHold)} more on hold in disputes` : undefined} />
        <Stat label={`Trust account (${s.trustBank})`} value={ghs(s.trustBalance)} sub="backs the e-money" />
        <Stat label="Switch position" value={ghs(Math.abs(s.switchPosition))} sub={s.switchPosition > 0 ? "owed to others" : s.switchPosition < 0 ? "owed to us, unsettled" : "settled"} />
        <Stat label="Fee income" value={ghs(s.revenue)} sub={s.airtimeSales || s.owedToBillers ? `airtime sold ${ghs(s.airtimeSales)} · owed to billers ${ghs(s.owedToBillers)}` : "after agent commission"} />
      </Stats>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "overview" && (
        <>
          <Section title="How this network gets going" hint={`${b.name} starts with only its head office: no customers, agents or merchants yet.`}>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
              <li>Register customers&apos; SIMs with the Ghana Card. {b.name} Head Office does this from the start and orders its own blank SIMs. To add more outlets, add SIM stock (SIMs tab) and authorise a service centre or SIM registration agent (SIM registration points tab).</li>
              <li>Open mobile money agents from the owner&apos;s Ghana Card (Mobile money agents tab), and onboard merchants on their own registered business lines.</li>
              <li>
                Customers open wallets {data.config.selfRegistration ? `by dialling ${b.shortcode}, or ` : ""}at a mobile money agent, then cash in and transact.
              </li>
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/t/${team}/care/${telco}`} className="btn">
                Open customer care{s.openTickets ? ` (${s.openTickets} open)` : ""}
              </Link>
              <Link href={`/t/${team}/sim-agent/${telco}`} className="btn">
                Go to a SIM registration point
              </Link>
              <Link href={`/t/${team}/momo-agent/${telco}`} className="btn">
                Go to a mobile money agent
              </Link>
              <button type="button" onClick={() => setTab("agents")} className="btn">
                Open a new mobile money agent
              </button>
            </div>
          </Section>
          <Section title="Activity">
            <Activity rows={data.activity} />
          </Section>
        </>
      )}

      {tab === "sims" && (
        <>
          <Section title="SIM stock" hint="Blank SIM cards with new numbers. A registration point takes one from stock for each new customer.">
            <ActionForm team={team} path={path} action="add_sims" submit="Add to stock" onDone={refresh} fields={[{ name: "count", label: "How many blank SIMs", type: "number", initial: "10" }]} />
            {data.stock.length > 0 && (
              <p className="mt-3 text-xs text-gray-600">
                <b>{s.simsInStock} in stock.</b> Next numbers: {data.stock.slice(0, 12).map((x) => x.msisdn).join(", ")}
                {s.simsInStock > 12 ? " …" : ""}
              </p>
            )}
          </Section>
          <Section title="Registered numbers" hint="Every number that has been registered to a Ghana Card on this network.">
            <Table
              rows={data.sims}
              empty="No SIM has been registered on this network yet."
              cols={[
                { label: "Number", cell: (x) => <span className="font-mono text-xs">{x.msisdn}</span> },
                { label: "Registered to", cell: (x) => x.owner },
                { label: "Ghana Card", cell: (x) => <span className="font-mono text-xs">{x.card}</span> },
                { label: "Registered", cell: (x) => (<><span className="whitespace-nowrap">{when(x.registeredAt)}</span><div className="text-[11px] text-gray-500">by {x.registeredBy}</div></>) },
                { label: "Wallet", cell: (x) => (x.hasWallet ? <Badge tone="green">yes</Badge> : <Badge>no</Badge>) },
                { label: "Status", cell: (x) => (<><Status value={x.status} />{x.blockReason && <div className="text-[11px] text-gray-500">{x.blockReason}</div>}{x.lastSwapAt && <div className="text-[11px] text-gray-500">SIM replaced {when(x.lastSwapAt)}</div>}</>) },
                {
                  label: "",
                  cell: (x) =>
                    x.status === "active" ? (
                      <ActionButton team={team} path={path} body={{ action: "sim_status", msisdn: x.msisdn, status: "blocked", reason: "Blocked by back office" }} onDone={refresh} danger>
                        Block
                      </ActionButton>
                    ) : x.status === "blocked" ? (
                      <ActionButton team={team} path={path} body={{ action: "sim_status", msisdn: x.msisdn, status: "active" }} onDone={refresh}>
                        Unblock
                      </ActionButton>
                    ) : null,
                },
              ]}
            />
          </Section>
          <Section title="SIM events" hint="Registrations, replacements, blocks and PIN resets, and who carried them out.">
            <Table
              rows={data.simEvents}
              empty="Nothing yet."
              cols={[
                { label: "Time", cell: (e) => <span className="whitespace-nowrap text-gray-500">{when(e.at)}</span> },
                { label: "Number", cell: (e) => <span className="font-mono text-xs">{e.msisdn}</span> },
                { label: "Event", cell: (e) => <Badge>{e.kind.replace(/_/g, " ")}</Badge> },
                { label: "By", cell: (e) => e.by },
                { label: "Detail", cell: (e) => e.detail },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "points" && (
        <>
          <Section
            title="Authorise a SIM registration point"
            hint={`These are ${b.name}'s service centres and registration agents. They register new SIMs against the Ghana Card, replace lost SIMs, and fix problems such as blocked lines and forgotten PINs. They do not handle cash. ${b.name} is answerable for what they do.`}
          >
            <ActionForm
              team={team}
              path={path}
              action="onboard_sim_agent"
              submit="Authorise"
              onDone={refresh}
              fields={[
                { name: "kind", label: "Type", type: "select", options: [["service_centre", "Service centre (run by the telco; can also do enhanced KYC)"], ["registration_agent", "SIM registration agent (authorised third party)"]] },
                { name: "name", label: "Outlet name", placeholder: "Adum Service Centre" },
                { name: "town", label: "Town", placeholder: "Kumasi" },
                { name: "card", label: "Ghana Card of the person in charge", placeholder: "GHA-000000000-0", hint: "Checked with NIA. They must be 18 or older." },
              ]}
            />
          </Section>
          <Section title="Registration points">
            <Table
              rows={data.simAgents}
              empty={`No registration point has served anyone yet. ${b.name} Head Office registers SIMs from the start; authorise more points here.`}
              cols={[
                { label: "ID", cell: (a) => <span className="font-mono text-xs">{a.id}</span> },
                { label: "Outlet", cell: (a) => a.name },
                { label: "Type", cell: (a) => (a.kind === "service_centre" ? "Service centre" : "Registration agent") },
                { label: "Town", cell: (a) => a.town },
                { label: "In charge", cell: (a) => a.owner },
                { label: "SIMs registered", right: true, cell: (a) => a.registered },
                { label: "Status", cell: (a) => <Status value={a.status} /> },
                {
                  label: "",
                  cell: (a) => (
                    <ActionButton team={team} path={path} body={{ action: "sim_agent_status", id: a.id, status: a.status === "active" ? "suspended" : "active" }} onDone={refresh} danger={a.status === "active"}>
                      {a.status === "active" ? "Suspend" : "Reinstate"}
                    </ActionButton>
                  ),
                },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "wallets" && (
        <>
          <Section title={`${b.wallet} wallets`} hint="Customers, agents and merchants. Freezing a wallet stops money going in or out.">
            <Table
              rows={data.wallets}
              empty="No wallets yet."
              cols={[
                { label: "Number", cell: (x) => <span className="font-mono text-xs">{x.msisdn}</span> },
                { label: "Name", cell: (x) => x.name },
                { label: "Type", cell: (x) => <Badge tone={x.type === "person" ? "gray" : "blue"}>{x.type === "person" ? "customer" : x.type}</Badge> },
                { label: "KYC tier", cell: (x) => x.tier },
                { label: "Balance", right: true, cell: (x) => ghs(x.balance) },
                { label: "Status", cell: (x) => <Status value={x.status} /> },
                {
                  label: "",
                  cell: (x) =>
                    x.status === "locked" ? (
                      <span className="text-[11px] text-gray-500">PIN reset at a service centre</span>
                    ) : (
                      <ActionButton team={team} path={path} body={{ action: "wallet_status", msisdn: x.msisdn, status: x.status === "frozen" ? "active" : "frozen" }} onDone={refresh} danger={x.status === "active"}>
                        {x.status === "frozen" ? "Unfreeze" : "Freeze"}
                      </ActionButton>
                    ),
                },
              ]}
            />
          </Section>
          <Section
            title="Change a wallet's KYC tier"
            hint={`Bank of Ghana limits by tier — ${Object.entries(data.limits).map(([t, l]) => `${t}: GHS ${l.daily.toLocaleString()} a day, GHS ${l.maxBalance.toLocaleString()} balance`).join("; ")}. Enhanced KYC needs proof of address.`}
          >
            <ActionForm
              team={team}
              path={path}
              action="upgrade_tier"
              submit="Change tier"
              onDone={refresh}
              fields={[
                { name: "msisdn", label: "Wallet number", placeholder: "024 000 0000" },
                { name: "tier", label: "New tier", type: "select", options: [["medium", "Medium"], ["enhanced", "Enhanced"], ["minimum", "Minimum"]] },
                { name: "proof", label: "Proof of address seen", placeholder: "e.g. ECG bill, March", optional: true, hint: "Required for enhanced KYC." },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "agents" && (
        <>
          <Section
            title="Open a mobile money agent"
            hint={`Mobile money agents take cash and give e-money (cash-in), give cash for e-money (cash-out), and open ${b.wallet} wallets for customers. They work from a dedicated agent line with its own float, separate from SIM registration points. All you need is the owner's Ghana Card: ${b.name} Head Office registers the agent line for them.`}
          >
            <OpenAgentForm team={team} telco={telco} brand={b} onDone={() => refresh()} />
          </Section>
          <Section title="Or use a business line the owner already has" hint="For an owner who has already registered a separate line for the business at a SIM registration point.">
            <ActionForm
              team={team}
              path={path}
              action="onboard_momo_agent"
              submit="Onboard agent"
              onDone={refresh}
              fields={[
                { name: "msisdn", label: "Agent line", placeholder: "Registered number with no wallet", hint: businessLine },
                { name: "name", label: "Business name", placeholder: "Yaw Mobile Money Centre" },
                { name: "town", label: "Town", placeholder: "Suame" },
                { name: "pin", label: "Agent PIN (4 digits)", type: "password" },
              ]}
            />
          </Section>
          <Section title="Mobile money agents" hint="Float is the agent's e-money. Cash is what is physically in their till.">
            <Table
              rows={data.momoAgents}
              empty="No mobile money agents yet."
              cols={[
                { label: "Agent no.", cell: (a) => <span className="font-mono text-xs">{a.code}</span> },
                { label: "Business", cell: (a) => a.name },
                { label: "Agent line", cell: (a) => <span className="font-mono text-xs">{a.msisdn}</span> },
                { label: "Town", cell: (a) => a.town },
                { label: "Float", right: true, cell: (a) => ghs(a.float) },
                { label: "Cash in till", right: true, cell: (a) => ghs(a.cash) },
                { label: "Commission earned", right: true, cell: (a) => ghs(a.commission) },
                { label: "Status", cell: (a) => <Status value={a.status} /> },
                {
                  label: "",
                  cell: (a) => (
                    <ActionButton team={team} path={path} body={{ action: "momo_agent_status", code: a.code, status: a.status === "active" ? "suspended" : "active" }} onDone={refresh} danger={a.status === "active"}>
                      {a.status === "active" ? "Suspend" : "Reinstate"}
                    </ActionButton>
                  ),
                },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "merchants" && (
        <>
          <Section title="Onboard a merchant" hint="Merchants only accept payments. Customers pay them with the merchant ID.">
            <ActionForm
              team={team}
              path={path}
              action="onboard_merchant"
              submit="Onboard merchant"
              onDone={refresh}
              fields={[
                { name: "msisdn", label: "Merchant line", placeholder: "Registered number with no wallet", hint: businessLine },
                { name: "name", label: "Business name", placeholder: "Ama's Provisions" },
                { name: "category", label: "Category", placeholder: "Provisions", optional: true },
                { name: "town", label: "Town", placeholder: "Ayeduase" },
                { name: "pin", label: "Merchant PIN (4 digits)", type: "password" },
              ]}
            />
          </Section>
          <Section title="Merchants">
            <Table
              rows={data.merchants}
              empty="No merchants yet."
              cols={[
                { label: "Merchant ID", cell: (m) => <span className="font-mono text-xs">{m.till}</span> },
                { label: "Business", cell: (m) => m.name },
                { label: "Category", cell: (m) => m.category },
                { label: "Town", cell: (m) => m.town },
                { label: "Line", cell: (m) => <span className="font-mono text-xs">{m.msisdn}</span> },
                { label: "Balance", right: true, cell: (m) => ghs(m.balance) },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "txns" && (
        <Section title="Transactions" hint="Every payment that touched this network, including refused ones. Click a row to see its ledger postings. A wallet-to-wallet payment sent from this network can be reversed here; a payment a customer disputes is handled in customer care.">
          <TxnTable
            team={team}
            rows={data.txns}
            action={(t) =>
              t.status === "success" && ["p2p", "merchant", "cashin", "cashout", "float"].includes(t.type) && (t as TxnRow & { fromParty: string }).fromParty === telco ? (
                <ActionButton team={team} path={path} body={{ action: "reverse", txnId: t.id }} confirmText={`Reverse ${ghs(t.amount)} from ${t.from} to ${t.to}?`} onDone={refresh} danger>
                  Reverse
                </ActionButton>
              ) : null
            }
          />
        </Section>
      )}

      {tab === "calls" && (
        <Section title="Call records" hint="Every voice call made from or to a number on this network, including calls that did not connect. The network records who called whom and for how long, not what was said.">
          <Table
            rows={data.calls}
            empty="No calls yet. Open two phones and dial one from the other."
            cols={[
              { label: "Time", cell: (c) => <span className="whitespace-nowrap text-gray-500">{when(c.at)}</span> },
              { label: "From", cell: (c) => (<><span className="font-mono text-xs">{c.from}</span><div className="text-[11px] text-gray-500">{c.fromNetwork}</div></>) },
              { label: "To", cell: (c) => (<><span className="font-mono text-xs">{c.to}</span><div className="text-[11px] text-gray-500">{c.toNetwork || "unknown"}</div></>) },
              { label: "Duration", right: true, cell: (c) => (c.seconds ? `${Math.floor(c.seconds / 60)}m ${c.seconds % 60}s` : "–") },
              { label: "Outcome", cell: (c) => (<><Status value={c.status === "ended" ? "success" : c.status} />{c.reason && c.status !== "ended" && <div className="mt-0.5 max-w-[260px] text-[11px] text-gray-500">{c.reason}</div>}</>) },
            ]}
          />
        </Section>
      )}

      {tab === "sms" && (
        <Section title="SMS records" hint="Every text sent from or to a number on this network: between people, from the network itself, and from businesses' apps. As at a real network, the record says who, when and whether it was delivered, never what the text said: only the phones that sent and received it hold the words.">
          <Table
            rows={data.sms}
            empty="No texts yet."
            cols={[
              { label: "Time", cell: (m) => <span className="whitespace-nowrap text-gray-500">{when(m.at)}</span> },
              { label: "From", cell: (m) => (<><span className="font-mono text-xs">{m.from}</span><div className="text-[11px] text-gray-500">{m.fromNetwork}</div></>) },
              { label: "To", cell: (m) => (<><span className="font-mono text-xs">{m.to}</span><div className="text-[11px] text-gray-500">{m.toNetwork || "unknown"}</div></>) },
              { label: "Type", cell: (m) => <Badge tone={m.kind === "person" ? "gray" : "blue"}>{m.kind === "person" ? "person to person" : m.kind === "app" ? "business app" : "from the network"}</Badge> },
              { label: "Parts", right: true, cell: (m) => m.parts },
              { label: "Status", cell: (m) => (<><Status value={m.status === "delivered" ? "success" : "failed"} />{m.reason && <div className="mt-0.5 max-w-[200px] text-[11px] text-gray-500">{m.reason}</div>}</>) },
            ]}
          />
        </Section>
      )}

      {tab === "services" && (
        <>
          <Section title={`What a ${b.wallet} wallet can do from the phone`} hint={`Everything here is reached from ${b.shortcode}. The menu itself, the bundles, the billers and the partner banks are in Settings, where they can be changed.`}>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Opening a wallet</dt>
                <dd className="mt-0.5 text-gray-800">
                  {data.services.registration.code ? `The subscriber dials ${data.services.registration.code}, or goes to an agent with their Ghana Card.` : `The subscriber dials ${b.shortcode}, or goes to an agent with their Ghana Card.`}{" "}
                  {data.services.registration.pinBySms ? "At an agent, a starting PIN is texted to the customer, who must replace it the first time they open the menu." : "At an agent, the customer can type their own PIN at the counter or leave it empty: a starting PIN is then texted to them, which they must replace the first time they open the menu."}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Withdrawing cash at an agent</dt>
                <dd className="mt-0.5 text-gray-800">
                  {data.services.cashOut === "customer_starts"
                    ? "The customer starts it on their own phone: the agent's number, the amount, their PIN. The agent is told by text and hands over the cash."
                    : "The agent checks the customer's Ghana Card and sends a request. The customer allows it on their phone with their PIN."}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Withdrawing at a cash machine</dt>
                <dd className="mt-0.5 text-gray-800">{data.services.atmBanks.length ? `The customer gets a voucher from the phone and uses it at a ${data.services.atmBanks.join(" or ")} cash machine with their phone number. The money leaves the wallet when the machine pays out.` : "Not on this network's menu."}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Also on the menu</dt>
                <dd className="mt-0.5 text-gray-800">Sending to wallets on any network and to bank accounts, paying merchants, moving money in from the owner&apos;s bank account, checking an agent before trusting one, and answering requests to approve.</dd>
              </div>
            </dl>
          </Section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Data bundles on sale" hint={`Airtime is bought in any amount. Sales so far: ${ghs(s.airtimeSales)}. A line's airtime and data show on *124#.`}>
              <Table rows={data.services.bundles} empty="No bundles." cols={[{ label: "Bundle", cell: (x) => x.name }, { label: "Price", right: true, cell: (x) => ghs(x.price) }, { label: "Data", right: true, cell: (x) => `${x.mb.toLocaleString("en")} MB` }, { label: "Lasts", right: true, cell: (x) => `${x.days} day${x.days === 1 ? "" : "s"}` }]} />
            </Section>
            <Section title="Billers" hint={`Money collected for billers is held for them: ${ghs(s.owedToBillers)} so far.`}>
              <Table rows={data.services.billers} empty="No billers." cols={[{ label: "Biller", cell: (x) => x.name }, { label: "The customer is asked", cell: (x) => x.ask }, { label: "", cell: (x) => (x.token ? <Badge tone="blue">returns a token</Badge> : "") }]} />
            </Section>
          </div>
          <Section title="Bills paid">
            <Table
              rows={data.bills}
              empty="No bills paid yet."
              cols={[
                { label: "Time", cell: (x) => <span className="whitespace-nowrap text-gray-500">{when(x.at)}</span> },
                { label: "Biller", cell: (x) => x.biller },
                { label: "Account", cell: (x) => <span className="font-mono text-xs">{x.account}</span> },
                { label: "Paid from", cell: (x) => <span className="font-mono text-xs">{x.from}</span> },
                { label: "Amount", right: true, cell: (x) => ghs(x.amount) },
                { label: "Token", cell: (x) => <span className="font-mono text-[11px]">{x.token}</span> },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "plugins" && <Plugins team={team} path={path} institution={b.name} view={data} onChange={refresh} />}

      {tab === "api" && (
        <>
          <ApiPartners
            team={team}
            path={path}
            partners={data.apiPartners}
            onChange={refresh}
            institution={b.name}
            apiPath={`/momo/${telco} and /network/${telco}`}
            what={`This is what ${b.name} gives a licensed payments or messaging company: taking and making ${b.wallet} payments, sending texts, and checking a subscriber's details.`}
            link={{
              name: "till",
              label: "Merchant account for payments",
              type: "select",
              options: [["", "None (texts and subscriber checks only)"], ...data.merchants.map((m) => [m.till, `${m.name} · merchant ID ${m.till}`] as const)],
              hint: "Payments are collected into, and paid out from, this merchant's wallet.",
            }}
          />
          <Section title="USSD short codes" hint="The NCA allocates a short code to a service provider. It only works for this network's subscribers once you switch it on here. Each step of a session is then forwarded to the provider's application.">
            <Table
              rows={data.shortCodes}
              empty="The NCA has not allocated any short codes yet."
              cols={[
                { label: "Code", cell: (c) => <span className="font-mono text-sm font-semibold">{c.code}</span> },
                { label: "Service provider", cell: (c) => c.owner },
                { label: "Application", cell: (c) => <span className="break-all font-mono text-[11px] text-gray-600">{c.url}</span> },
                { label: `On ${b.name}`, cell: (c) => <Status value={c.on ? "active" : "suspended"} /> },
                {
                  label: "",
                  cell: (c) => (
                    <ActionButton team={team} path={path} body={{ action: "short_code", code: c.code, on: !c.on }} onDone={refresh} danger={c.on} dark={!c.on}>
                      {c.on ? "Switch off" : "Switch on"}
                    </ActionButton>
                  ),
                },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "settings" && (
        <>
          <Section title="Rules" hint="Changes apply immediately to every customer on this network.">
            <SettingsForm
              team={team}
              path={path}
              onSaved={refresh}
              fields={[
                { pointer: "/selfRegistration", label: "Customers can open a wallet from the phone", value: data.config.selfRegistration, hint: "If no, they must go to a mobile money agent." },
                { pointer: "/ownBankAccountFree", label: "Free transfers to the customer's own bank account", value: data.config.ownBankAccountFree !== false, hint: "Transfers to anyone else's bank account are always charged the 'to_bank' fee." },
                { pointer: "/pinAttemptsBeforeLock", label: "Wrong PINs before the wallet locks", value: data.config.pinAttemptsBeforeLock },
                { pointer: "/approvalMinutes", label: "Minutes to approve a cash-out", value: data.config.approvalMinutes },
                { pointer: "/simSwapMomoHoldHours", label: "Hours sending is paused after a SIM replacement", value: data.config.simSwapMomoHoldHours, hint: "0 switches the pause off." },
              ]}
            />
          </Section>
          <Section title="Customer fees" hint="Per transaction type, as amount bands in GHS. 'to_bank' is not charged when customers move money to their own bank account, unless you switch that off above. The first band whose 'upTo' covers the amount applies ('upTo: null' is the top band). Fee = flat + pct% of the amount, capped at 'max'.">
            <SettingsJson team={team} path={path} pointer="/fees" value={data.config.fees} onSaved={refresh} />
          </Section>
          <Section title="Agent commission" hint="What this network pays its agents for each cash-in and cash-out, in the same band format.">
            <SettingsJson team={team} path={path} pointer="/agentCommission" value={data.config.agentCommission} onSaved={refresh} rows={8} />
          </Section>
          <Section title={`USSD menu (${b.shortcode})`} hint="The menu tree customers see when they dial the short code. Node types: menu, input, branch, warning, action, message. To add a screen, add a node and point an existing 'next' at it.">
            <SettingsJson team={team} path={path} pointer="/menu" value={data.config.menu} onSaved={refresh} rows={22} />
          </Section>
          <Section title="SMS notifications" hint="The text messages this network sends, one per event. Switch any of them off with 'enabled: false'. Placeholders in {{double braces}} are filled in when the message is sent.">
            <SettingsJson team={team} path={path} pointer="/notifications" value={data.config.notifications} onSaved={refresh} rows={18} />
          </Section>
          <Section title="Settings history">
            <SettingsHistory team={team} surface={`telco.${telco}`} onChange={refresh} />
          </Section>
        </>
      )}
    </Shell>
  );
}
