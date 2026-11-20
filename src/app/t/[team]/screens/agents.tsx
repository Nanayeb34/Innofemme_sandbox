"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TelcoMark } from "@/components/telco-mark";
import { ActionForm, Badge, ID_FIELDS, Loading, Section, Shell, Stat, Stats, Status, Table, Tabs, TxnTable, useView, type TxnRow } from "@/components/ui";
import { ghs, when } from "@/lib/client";

const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };
const TELCOS: [string, string][] = [["mtn", "MTN"], ["telecel", "Telecel"], ["at", "AT"]];

/** Remembers which agent this browser is acting as, per network. */
function useChosen(key: string): [string, (v: string) => void] {
  const [value, setValue] = useState("");
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's saved choice once
      setValue(localStorage.getItem(key) ?? "");
    } catch {}
  }, [key]);
  return [
    value,
    (v) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {}
    },
  ];
}

function NetworkSwitch({ team, kind, telco }: { team: string; kind: string; telco: string }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-current/30 text-sm">
      {TELCOS.map(([id, name]) => (
        <Link key={id} href={`/t/${team}/${kind}/${id}`} className={`px-3 py-1.5 ${id === telco ? "bg-black/20 font-semibold" : "hover:bg-black/10"}`}>
          {name}
        </Link>
      ))}
    </div>
  );
}

function Who({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm sm:w-auto sm:max-w-full">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- SIM registration and troubleshooting point ----------

interface SimPointView {
  telco: string;
  brand: { name: string; wallet: string; color: string; shortcode: string; logo: string | null };
  agents: { id: string; name: string; kind: string; town: string; status: string }[];
  current: string | null;
  stockCount: number;
  stock: string[];
  events: { id: number; msisdn: string; at: string; kind: string; detail: string }[];
  rules: { maxSimsPerCard: number; minimumAge: number; primaryNumberApproval: boolean };
}

const SIM_TABS = [["register", "Register a new SIM"], ["swap", "Replace a SIM"], ["fix", "Troubleshooting"], ["log", "Work done here"]] as const;

/** A phone that scanned the agent code goes back to the agent menu; a team laptop goes back to all systems. */
const backFor = (team: string, role: string) => (role === "team" ? undefined : { href: `/t/${team}/agent`, label: "Agent menu" });

export function SimPoint({ team, telco, role }: { team: string; telco: string; role: string }) {
  const [agent, setAgent] = useChosen(`sim-agent:${team}:${telco}`);
  const path = `/s/sim-agent/${telco}`;
  const { data, error, refresh } = useView<SimPointView>(team, `${path}?agent=${encodeURIComponent(agent)}`);
  const [tab, setTab] = useState<(typeof SIM_TABS)[number][0]>("register");
  if (!data) return <Loading error={error} />;
  const b = data.brand;
  const active = data.agents.filter((a) => a.status === "active");
  const me = active.find((a) => a.id === data.current);
  const extra = { agent: me?.id };
  const owner = [{ name: "msisdn", label: `${b.name} number`, placeholder: "024 000 0000" }, ...ID_FIELDS];

  return (
    <Shell team={team} title={`${b.name} SIM registration point`} subtitle="SIM registration and troubleshooting" color={b.color} textOn={TEXT_ON[telco]} mark={<TelcoMark telco={telco} logo={b.logo} height={34} />} right={<NetworkSwitch team={team} kind="sim-agent" telco={telco} />} back={backFor(team, role)}>
      {!me ? (
        <Section title="No registration point on this network yet">
          <p className="text-sm text-gray-700">
            {b.name} has not authorised a service centre or SIM registration agent.{" "}
            {role === "team" ? (
              <>
                Go to the{" "}
                <Link className="underline" href={`/t/${team}/telco/${telco}`}>
                  {b.name} back office
                </Link>{" "}
                → SIM registration points, and authorise one.
              </>
            ) : (
              <>Ask your team to authorise one in the {b.name} back office, then come back.</>
            )}
          </p>
        </Section>
      ) : (
        <>
          <Who label="You are working at" value={me.id} onChange={setAgent} options={active.map((a) => [a.id, `${a.name}, ${a.town} (${a.kind === "service_centre" ? "service centre" : "registration agent"} ${a.id})`])} />
          <Tabs tabs={SIM_TABS} value={tab} onChange={setTab} />

          {tab === "register" && (
            <Section
              title="Register a new SIM"
              hint={`The customer presents their Ghana Card and gives a fingerprint. Both are checked live with NIA before the number is switched on. NCA rules: at most ${data.rules.maxSimsPerCard} SIMs per card across all networks, age ${data.rules.minimumAge} or over${data.rules.primaryNumberApproval ? ", and a second SIM needs an approval code sent to the customer's first number" : ""}.`}
            >
              {data.stockCount === 0 && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">There are no blank SIMs in stock. {b.name} back office must add SIM stock first.</p>}
              <ActionForm
                team={team}
                path={path}
                action="register"
                submit="Verify with NIA and activate"
                extra={extra}
                onDone={refresh}
                keep={["card", "fingerprint"]}
                fields={[
                  ...ID_FIELDS,
                  { name: "msisdn", label: "Number to give the customer", type: "select", options: [["", "Next available number"], ...data.stock.map((m) => [m, m] as const)] },
                  { name: "otp", label: "Approval code", optional: true, placeholder: "6 digits", hint: "Only for a customer who already has a number: the code is sent to their first number by SMS." },
                ]}
              />
              <p className="mt-3 text-xs text-gray-500">{data.stockCount} blank SIM(s) in stock.</p>
            </Section>
          )}

          {tab === "swap" && (
            <Section title="Replace a lost, stolen or damaged SIM" hint={`The number moves to a new SIM card after the owner is verified with Ghana Card and fingerprint. A blocked number becomes active again on the new SIM. ${b.wallet} may pause sending for a while afterwards, as a safeguard.`}>
              <ActionForm team={team} path={path} action="swap" submit="Verify owner and issue new SIM" extra={extra} onDone={refresh} fields={owner} />
            </Section>
          )}

          {tab === "fix" && (
            <>
              <Section title="Look up a number" hint="Registration status, owner and wallet status.">
                <ActionForm team={team} path={path} action="lookup" submit="Look up" extra={extra} keep={["msisdn"]} fields={[{ name: "msisdn", label: `${b.name} number` }]} />
              </Section>
              <Section title={`Reset a ${b.wallet} PIN`} hint="For a forgotten PIN or a wallet locked after wrong attempts. The owner is verified, then a temporary PIN is sent to the phone by SMS.">
                <ActionForm team={team} path={path} action="pin_reset" submit="Verify owner and reset PIN" extra={extra} onDone={refresh} fields={owner} />
              </Section>
              <Section title="Block a number" hint="For a lost or stolen phone. No ID is needed to block: it is the safe direction.">
                <ActionForm team={team} path={path} action="block" submit="Block number" extra={extra} onDone={refresh} fields={[{ name: "msisdn", label: `${b.name} number` }, { name: "reason", label: "Reason", optional: true, placeholder: "Phone stolen" }]} />
              </Section>
              <Section title="Unblock a number" hint="The owner is verified first.">
                <ActionForm team={team} path={path} action="unblock" submit="Verify owner and unblock" extra={extra} onDone={refresh} fields={owner} />
              </Section>
              <Section title="Upgrade a wallet to enhanced KYC" hint="Service centres only. Needs the owner in person and proof of address.">
                <ActionForm team={team} path={path} action="upgrade_enhanced" submit="Verify and upgrade" extra={extra} onDone={refresh} fields={[...owner, { name: "proof", label: "Proof of address seen", placeholder: "e.g. ECG bill, March" }]} />
              </Section>
              <Section title="Disconnect a number for good" hint="At the owner's request. The wallet must be empty first.">
                <ActionForm team={team} path={path} action="deactivate" submit="Verify owner and disconnect" extra={extra} onDone={refresh} fields={owner} />
              </Section>
            </>
          )}

          {tab === "log" && (
            <Section title={`Work done at ${me.name}`}>
              <Table
                rows={data.events}
                empty="Nothing has been done at this point yet."
                cols={[
                  { label: "Time", cell: (e) => <span className="whitespace-nowrap text-gray-500">{when(e.at)}</span> },
                  { label: "Number", cell: (e) => <span className="font-mono text-xs">{e.msisdn}</span> },
                  { label: "What", cell: (e) => <Badge>{e.kind.replace(/_/g, " ")}</Badge> },
                  { label: "Detail", cell: (e) => e.detail },
                ]}
              />
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}

// ---------- mobile money agent ----------

interface MomoPointView {
  telco: string;
  brand: { name: string; wallet: string; color: string; shortcode: string; logo: string | null };
  agents: { code: string; name: string; town: string; status: string }[];
  agent: {
    code: string; name: string; msisdn: string; town: string; status: string; float: number; cash: number; commission: number;
    requests: { ref: string; customer: string; amount: number; status: string; reason: string | null; at: string }[];
    txns: TxnRow[];
  } | null;
  /** Who starts a withdrawal on this network. */
  cashOut: "agent_requests" | "customer_starts";
  pinBySms: boolean;
}

const MOMO_TABS = [["cashin", "Cash-in (deposit)"], ["cashout", "Cash-out (withdrawal)"], ["register", "Register a customer"], ["float", "Float and till"], ["txns", "Transactions"]] as const;

export function MomoPoint({ team, telco, role }: { team: string; telco: string; role: string }) {
  const [code, setCode] = useChosen(`momo-agent:${team}:${telco}`);
  const path = `/s/momo-agent/${telco}`;
  const { data, error, refresh } = useView<MomoPointView>(team, `${path}?agent=${encodeURIComponent(code)}`);
  const [tab, setTab] = useState<(typeof MOMO_TABS)[number][0]>("cashin");
  if (!data) return <Loading error={error} />;
  const active = data.agents.filter((a) => a.status === "active");
  const b = data.brand;
  const me = data.agent;
  const extra = { agent: me?.code };
  const pin = { name: "pin", label: "Your agent PIN", type: "password" as const };
  const done = refresh;

  return (
    <Shell team={team} title={`${b.wallet} agent`} subtitle="Mobile money agent" color={b.color} textOn={TEXT_ON[telco]} mark={<TelcoMark telco={telco} logo={b.logo} height={34} />} right={<NetworkSwitch team={team} kind="momo-agent" telco={telco} />} back={backFor(team, role)}>
      {!me ? (
        <Section title="No mobile money agent on this network yet">
          <p className="text-sm text-gray-700">
            {role === "team" ? (
              <>
                Register a SIM for the business at a SIM registration point, then go to the{" "}
                <Link className="underline" href={`/t/${team}/telco/${telco}`}>
                  {b.name} back office
                </Link>{" "}
                → Mobile money agents, and onboard it.
              </>
            ) : (
              <>Ask your team to onboard a mobile money agent in the {b.name} back office, then come back.</>
            )}
          </p>
        </Section>
      ) : (
        <>
          <Who label="You are" value={me.code} onChange={setCode} options={active.map((a) => [a.code, `${a.name}, ${a.town} (agent no. ${a.code})`])} />
          <Stats>
            <Stat label="Float (e-money)" value={ghs(me.float)} sub="what you can deposit for customers" tone={me.float === 0 ? "bad" : undefined} />
            <Stat label="Cash in the till" value={ghs(me.cash)} sub="what you can pay out" />
            <Stat label="Commission earned" value={ghs(me.commission)} />
            <Stat label="Agent line" value={<span className="font-mono text-base">{me.msisdn}</span>} sub={`agent no. ${me.code}`} />
          </Stats>
          <Tabs tabs={MOMO_TABS} value={tab} onChange={setTab} />

          {tab === "cashin" && (
            <Section title="Cash-in" hint="The customer hands you cash. You send the same amount of e-money from your float to their wallet. It is free for the customer and you earn a commission. Your float goes down and your till goes up.">
              {me.float === 0 && (
                <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  You have no float. Buy some at a{" "}
                  {role === "team" ? (
                    <Link className="underline" href={`/t/${team}/bank/gcb`}>
                      bank
                    </Link>
                  ) : (
                    "bank"
                  )}
                  : the bank sends money to your agent line {me.msisdn}.
                </p>
              )}
              <ActionForm team={team} path={path} action="cash_in" submit="Deposit to customer" extra={extra} onDone={done} fields={[{ name: "msisdn", label: "Customer's number" }, { name: "amount", label: "Amount (GHS)", type: "number" }, pin]} />
            </Section>
          )}

          {tab === "cashout" && data.cashOut === "customer_starts" && (
            <>
              <Section title="Cash-out" hint={`On ${b.wallet} the customer starts the withdrawal on their own phone. You do not send a request.`}>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-800">
                  <li>
                    Give the customer your agent number: <span className="font-mono font-semibold">{me.code}</span>.
                  </li>
                  <li>
                    They dial <span className="font-mono">{b.shortcode}</span>, choose to withdraw cash from an agent, and enter your agent number, the amount and their PIN.
                  </li>
                  <li>You get a text and the withdrawal appears below. Check the amount, then hand over the cash. Your till goes down and your float goes up.</li>
                </ol>
                <p className="mt-2 text-xs text-gray-500">Never ask for the customer&apos;s PIN, and never enter it for them.</p>
              </Section>
              <Section title="Withdrawals at this agent">
                <TxnTable team={team} path={path} rows={me.txns.filter((t) => t.type === "cashout")} empty="No withdrawals yet." />
              </Section>
            </>
          )}

          {tab === "cashout" && data.cashOut !== "customer_starts" && (
            <>
              <Section
                title="Cash-out"
                hint={`You check the customer's Ghana Card: the name must match the wallet. You enter their number and the amount. They then dial ${b.shortcode}, choose option 4 and approve with their PIN. Pay out the cash only once the request shows as successful.`}
              >
                <ActionForm
                  team={team}
                  path={path}
                  action="cash_out"
                  submit="Send withdrawal request"
                  extra={extra}
                  onDone={done}
                  fields={[{ name: "msisdn", label: "Customer's number" }, { name: "amount", label: "Amount (GHS)", type: "number" }, { name: "card", label: "Customer's Ghana Card number", placeholder: "GHA-000000000-0", hint: "Recorded and checked against the wallet owner." }]}
                />
              </Section>
              <Section title="Withdrawal requests">
                <Table
                  rows={me.requests}
                  empty="No withdrawal requests yet."
                  cols={[
                    { label: "Time", cell: (r) => <span className="whitespace-nowrap text-gray-500">{when(r.at)}</span> },
                    { label: "Customer", cell: (r) => <span className="font-mono text-xs">{r.customer}</span> },
                    { label: "Amount", right: true, cell: (r) => ghs(r.amount) },
                    { label: "Status", cell: (r) => (<><Status value={r.status} />{r.status === "PENDING" && <span className="ml-2 text-xs text-gray-500">waiting for the customer</span>}{r.reason && <div className="text-[11px] text-gray-500">{r.reason}</div>}</>) },
                  ]}
                />
              </Section>
            </>
          )}

          {tab === "register" && (
            <Section
              title={`Register a customer for ${b.wallet}`}
              hint={`The customer must own a registered SIM on this network. You verify their Ghana Card and fingerprint, so the wallet opens on medium KYC. ${data.pinBySms ? `You never see the PIN: a starting PIN is texted to the customer, who dials ${b.shortcode} to create their own.` : "For a customer who opened a wallet from their phone, the same check upgrades it from minimum to medium (leave the PIN empty)."}`}
            >
              <ActionForm
                team={team}
                path={path}
                action="register_customer"
                submit="Verify and register"
                extra={extra}
                onDone={done}
                fields={[
                  { name: "msisdn", label: "Customer's number" },
                  ...ID_FIELDS,
                  ...(data.pinBySms ? [] : [{ name: "pin", label: "Customer chooses a 4-digit PIN", type: "password" as const, optional: true, hint: "Not needed when upgrading an existing wallet." }]),
                ]}
              />
            </Section>
          )}

          {tab === "float" && (
            <>
              <Section title="Buying float" hint="Float is e-money you buy with real money. Take cash or your bank balance to a bank and ask it to send money to your agent line. Other agents can also send you float.">
                {role === "team" ? (
                  <Link href={`/t/${team}/bank/gcb`} className="btn">
                    Go to a bank
                  </Link>
                ) : (
                  <p className="text-sm text-gray-600">Your team runs the bank consoles. Give them your agent line: {me.msisdn}.</p>
                )}
              </Section>
              <Section title="Send float to another agent" hint="Agents on the same network rebalance each other. No fee.">
                <ActionForm team={team} path={path} action="send_float" submit="Send float" extra={extra} onDone={done} fields={[{ name: "toCode", label: "Receiving agent number", type: "select", options: data.agents.filter((a) => a.code !== me.code).map((a) => [a.code, `${a.name} (${a.code})`] as const) }, { name: "amount", label: "Amount (GHS)", type: "number" }, pin]} disabled={data.agents.length < 2 ? "There is no other agent on this network yet." : undefined} />
              </Section>
              <Section title="Cash in the till" hint="Cash is physical. Record it when you bring cash to the shop, or take the day's cash to the bank.">
                <ActionForm team={team} path={path} action="till" submit="Update till" extra={extra} onDone={done} fields={[{ name: "direction", label: "What happened", type: "select", options: [["in", "I put cash into the till"], ["out", "I took cash out of the till"]] }, { name: "amount", label: "Amount (GHS)", type: "number" }]} />
              </Section>
            </>
          )}

          {tab === "txns" && (
            <Section title="Transactions on the agent line">
              <TxnTable team={team} rows={me.txns} path={path} />
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}
