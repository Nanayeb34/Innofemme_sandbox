"use client";

import { useState } from "react";
import { TelcoMark } from "@/components/telco-mark";
import { ActionButton, ActionForm, Badge, Loading, Section, Shell, Stat, Stats, Status, Table, Tabs, TxnTable, useView, type TxnRow } from "@/components/ui";
import { ghs, when } from "@/lib/client";
import { useCalls, useElapsed } from "./calls";

interface TicketRow {
  id: string;
  msisdn: string;
  customer: string;
  category: string;
  status: string;
  channel: string;
  role: string | null;
  linked: string | null;
  amount: number | null;
  held: number;
  returned: number;
  resolution: string | null;
  openedAt: string;
  updatedAt: string;
}
interface TicketDetail extends TicketRow {
  description: string;
  events: { at: string; by: string; note: string }[];
  txn: TxnRow | null;
  recipientBalance: number | null;
  waitingForRecipient: boolean;
  can: { hold: boolean; askRecipient: boolean; returnFunds: boolean; forward: boolean; reverseAgent: boolean; close: boolean };
}
interface Customer {
  msisdn: string;
  found: boolean;
  identity: { name: string; dob: string; card: string; town: string } | null;
  sim: { status: string; registeredAt: string; lastSwapAt: string | null; blockReason: string | null };
  wallet: { name: string; type: string; tier: string; status: string; balance: number } | null;
  txns: (TxnRow & { out: boolean })[];
  tickets: TicketRow[];
}
interface CareView {
  telco: string;
  brand: { name: string; wallet: string; color: string; shortcode: string; careLine: string; logo: string | null; approvals: string };
  endpoint: string;
  waiting: number;
  stats: { open: number; awaitingRecipient: number; withOtherNetwork: number; fromOtherNetworks: number; closed: number; onHold: number };
  tickets: TicketRow[];
  ticket: TicketDetail | null;
  customer: Customer | null;
  categories: [string, string][];
}

const TEXT_ON: Record<string, string> = { mtn: "#111827", telecel: "#ffffff", at: "#ffffff" };
const CHANNEL: Record<string, string> = { call: "call to 100", ussd: "customer's phone", back_office: "back office", network: "another network" };
type Tab = "tickets" | "customer";

export default function Care({ team, telco }: { team: string; telco: string }) {
  const path = `/s/care/${telco}`;
  const [ticketId, setTicketId] = useState("");
  const [customer, setCustomer] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("tickets");
  const [online, setOnline] = useState(false);
  const { data, error, refresh } = useView<CareView>(team, `${path}?ticket=${encodeURIComponent(ticketId)}&customer=${encodeURIComponent(customer)}`, 2500);
  const [calls, voiceRef] = useCalls(team, online && data ? data.endpoint : "");
  const elapsed = useElapsed(calls.connectedAt);
  if (!data) return <Loading error={error} />;
  const b = data.brand;
  const s = data.stats;
  const call = calls.call;
  const look = (number: string) => {
    setSearch(number);
    setCustomer(number);
    setTab("customer");
  };
  const openTicket = (id: string) => {
    setTicketId(id);
    setTab("tickets");
  };
  const t = data.ticket;
  const c = data.customer;

  return (
    <Shell team={team} title={`${b.name} customer care`} subtitle={`Call centre · customers dial ${b.careLine}`} color={b.color} textOn={TEXT_ON[telco]} mark={<TelcoMark telco={telco} logo={b.logo} height={34} />}>
      <audio ref={voiceRef} autoPlay playsInline className="hidden" />

      <section className={`card mb-4 flex flex-wrap items-center gap-3 p-4 ${call ? "border-green-400 bg-green-50" : ""}`}>
        <div className="mr-auto min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Phone line {b.careLine}</div>
          {!online ? (
            <div className="text-sm text-gray-700">You are off line. Customers who dial {b.careLine} hear that customer care is closed.</div>
          ) : call?.status === "ringing" ? (
            <div className="text-base font-semibold text-gray-900">Incoming call from {call.peer}</div>
          ) : call ? (
            <div className="text-base font-semibold text-gray-900">
              On a call with {call.peer} · {calls.audio === "connected" ? elapsed : calls.audio === "failed" ? "audio could not connect" : "connecting audio…"}
            </div>
          ) : (
            <div className="text-sm text-gray-700">
              On line and waiting for calls.{data.waiting > 0 ? ` ${data.waiting} caller(s) waiting.` : ""} {calls.note && <span className="text-gray-500">Last call: {calls.note}</span>}
            </div>
          )}
        </div>
        {call?.status === "ringing" ? (
          <>
            <button
              className="btn btn-dark"
              onClick={() => {
                const from = call.peer;
                void calls.answer().then(() => look(from));
              }}
            >
              Answer
            </button>
            <button className="btn btn-danger" onClick={() => void calls.end()}>
              Decline
            </button>
          </>
        ) : call ? (
          <>
            <button className="btn" onClick={() => look(call.peer)}>
              Caller&apos;s record
            </button>
            <button className="btn" onClick={calls.toggleMute}>
              {calls.muted ? "Unmute" : "Mute"}
            </button>
            <button className="btn btn-danger" onClick={() => void calls.end()}>
              End call
            </button>
          </>
        ) : (
          <button className={`btn ${online ? "" : "btn-dark"}`} onClick={() => setOnline(!online)}>
            {online ? "Go off line" : "Go on line to take calls"}
          </button>
        )}
      </section>

      <Stats>
        <Stat label="Open tickets" value={s.open} tone={s.open ? "bad" : undefined} />
        <Stat label="Waiting for recipient" value={s.awaitingRecipient} sub="asked to return money" />
        <Stat label="With another network" value={s.withOtherNetwork} sub="sent through the switch" />
        <Stat label="From other networks" value={s.fromOtherNetworks} sub="for us to decide" tone={s.fromOtherNetworks ? "bad" : undefined} />
        <Stat label="Funds on hold" value={ghs(s.onHold)} sub="in disputes" />
        <Stat label="Closed tickets" value={s.closed} />
      </Stats>
      <Tabs tabs={[["tickets", "Tickets", data.tickets.length], ["customer", "Customer record"]] as const} value={tab} onChange={setTab} />

      {tab === "tickets" && (
        <>
          {t && (
            <Section
              title={`Ticket ${t.id}`}
              hint={`${t.category} · ${t.customer || "customer"} ${t.msisdn} · raised by ${CHANNEL[t.channel] ?? t.channel} · opened ${when(t.openedAt)}`}
              right={
                <div className="flex items-center gap-2">
                  <Status value={t.status} />
                  <button className="btn !px-2 !py-1 !text-xs" onClick={() => setTicketId("")}>
                    Close panel
                  </button>
                </div>
              }
            >
              <p className="text-sm text-gray-800">{t.description}</p>
              {t.resolution && <p className="mt-1 text-sm font-medium text-gray-900">Decision: {t.resolution}</p>}
              <button className="mt-2 text-xs underline" onClick={() => look(t.msisdn)}>
                Open {t.msisdn}&apos;s customer record
              </button>

              {t.txn && (
                <div className="mt-4 rounded-lg border border-gray-200 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Disputed payment</div>
                  <div className="mt-1 text-sm text-gray-900">
                    {ghs(t.txn.amount)} from {t.txn.from} to {t.txn.to} · {when(t.txn.at)} · Trans ID {t.txn.ref}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700">
                    <span>
                      On hold: <b>{ghs(t.held)}</b>
                    </span>
                    <span>
                      Returned to sender: <b>{ghs(t.returned)}</b>
                    </span>
                    {t.recipientBalance !== null && (
                      <span>
                        Left in recipient&apos;s wallet: <b>{ghs(t.recipientBalance)}</b>
                      </span>
                    )}
                    {t.linked && (
                      <span>
                        Other network&apos;s ticket: <b>{t.linked}</b>
                      </span>
                    )}
                  </div>
                  {t.role === "sender" && (
                    <p className="mt-2 text-xs text-gray-600">
                      The money is on another network. Only that network can hold it, ask the recipient, or send it back. {t.linked ? "This ticket updates as they act and closes when they decide." : "Send the dispute to them through the national switch."}
                    </p>
                  )}
                  {t.waitingForRecipient && <p className="mt-2 text-xs text-amber-800">The recipient has been asked to return the money and has not answered yet. They answer on their phone: dial {b.shortcode}, {b.approvals}.</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {t.can.forward && (
                      <ActionButton team={team} path={path} body={{ action: "forward", ticket: t.id }} onDone={refresh} dark>
                        Send to the recipient&apos;s network
                      </ActionButton>
                    )}
                    {t.can.hold && (
                      <ActionButton team={team} path={path} body={{ action: "hold", ticket: t.id }} onDone={refresh} dark>
                        Put recipient&apos;s funds on hold
                      </ActionButton>
                    )}
                    {t.can.askRecipient && !t.waitingForRecipient && (
                      <ActionButton team={team} path={path} body={{ action: "ask_recipient", ticket: t.id }} onDone={refresh}>
                        Ask recipient to return it
                      </ActionButton>
                    )}
                    {t.can.returnFunds && (
                      <ActionButton team={team} path={path} body={{ action: "return_funds", ticket: t.id }} confirmText={`Send the ${ghs(t.held)} on hold back to the sender?`} onDone={refresh} dark>
                        Return held funds to sender
                      </ActionButton>
                    )}
                    {t.can.reverseAgent && (
                      <ActionButton team={team} path={path} body={{ action: "reverse_agent", ticket: t.id }} confirmText="Reverse this agent transaction in full?" onDone={refresh} dark>
                        Reverse transaction
                      </ActionButton>
                    )}
                  </div>
                </div>
              )}

              <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-gray-500">What has happened</h3>
              <ul className="mt-1 divide-y divide-gray-100 text-sm">
                {t.events.map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-x-3 py-1.5 sm:flex-nowrap">
                    <span className="w-24 shrink-0 text-xs text-gray-500">{when(e.at)}</span>
                    <span className="w-44 shrink-0 text-xs font-medium text-gray-700">{e.by}</span>
                    <span className="min-w-0 basis-full break-words text-gray-800 sm:basis-auto">{e.note}</span>
                  </li>
                ))}
              </ul>

              {t.status !== "resolved" && t.status !== "rejected" && (
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Add a note</h3>
                    <ActionForm team={team} path={path} action="note" submit="Add note" extra={{ ticket: t.id }} onDone={refresh} fields={[{ name: "text", label: "Note", placeholder: "What you did or were told" }]} />
                  </div>
                  {t.can.close && (
                    <div>
                      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Close the ticket</h3>
                      <ActionForm
                        team={team}
                        path={path}
                        action="close"
                        submit="Close ticket"
                        extra={{ ticket: t.id }}
                        onDone={refresh}
                        fields={[
                          { name: "outcome", label: "Outcome", type: "select", options: [["resolved", "Resolved"], ["rejected", "Rejected (any funds on hold go back to the recipient)"]] },
                          { name: "resolution", label: "What was decided", placeholder: "Sent to the customer by SMS" },
                        ]}
                      />
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          <Section title="Tickets" hint="Open tickets first. Click one to work on it. Customers open tickets by calling 100 or from their phone's wallet menu; other networks send disputes through the switch.">
            <Table
              rows={data.tickets}
              empty={`No tickets yet. A customer can dial ${b.shortcode} → My Wallet → Report a Problem, or call ${b.careLine}.`}
              onRow={(k) => setTicketId(k.id)}
              cols={[
                { label: "Ticket", cell: (k) => <span className="font-mono text-xs font-semibold">{k.id}</span> },
                { label: "Updated", cell: (k) => <span className="whitespace-nowrap text-gray-500">{when(k.updatedAt)}</span> },
                { label: "Customer", cell: (k) => (<>{k.customer}<div className="font-mono text-[11px] text-gray-500">{k.msisdn}</div></>) },
                { label: "About", cell: (k) => k.category },
                { label: "Amount", right: true, cell: (k) => (k.amount === null ? "–" : ghs(k.amount)) },
                { label: "Raised by", cell: (k) => <Badge tone={k.channel === "network" ? "blue" : "gray"}>{CHANNEL[k.channel] ?? k.channel}</Badge> },
                { label: "Status", cell: (k) => (<><Status value={k.status} />{k.held > 0 && <div className="mt-0.5 text-[11px] text-gray-500">{ghs(k.held)} on hold</div>}</>) },
              ]}
            />
          </Section>
        </>
      )}

      {tab === "customer" && (
        <>
          <Section title="Find a customer" hint={`Any ${b.name} number. On a call, the caller's record opens when you answer.`}>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setCustomer(search.trim());
              }}
            >
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="024 000 0000" aria-label="Customer's number" className="min-w-[200px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <button className="btn btn-dark">Look up</button>
            </form>
            {c && !c.found && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{c.msisdn} is not a registered {b.name} number.</p>}
          </Section>

          {c?.found && (
            <>
              <Section title="Security questions" hint="A call centre cannot check a fingerprint. Ask the caller these and compare their answers with the record before you do anything for them.">
                <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <Fact label="Full name" value={c.identity?.name ?? "–"} />
                  <Fact label="Date of birth" value={c.identity?.dob ?? "–"} />
                  <Fact label="Ghana Card number" value={c.identity?.card ?? "–"} mono />
                  <Fact label="Town" value={c.identity?.town ?? "–"} />
                </div>
              </Section>

              <Section
                title={`${c.msisdn}`}
                right={
                  <div className="flex flex-wrap gap-2">
                    {c.sim.status === "active" && (
                      <ActionButton team={team} path={path} body={{ action: "block_sim", msisdn: c.msisdn }} confirmText="Block this number? The customer will need a service centre and their Ghana Card to get it back." onDone={refresh} danger>
                        Block SIM (lost or stolen)
                      </ActionButton>
                    )}
                    {c.wallet?.status === "active" && (
                      <ActionButton team={team} path={path} body={{ action: "freeze_wallet", msisdn: c.msisdn }} confirmText="Freeze this wallet? No money can go in or out until the back office unfreezes it." onDone={refresh} danger>
                        Freeze wallet
                      </ActionButton>
                    )}
                  </div>
                }
              >
                <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <Fact label="SIM" value={<Status value={c.sim.status} />} sub={c.sim.blockReason ?? `registered ${when(c.sim.registeredAt)}`} />
                  <Fact label="Last SIM replacement" value={c.sim.lastSwapAt ? when(c.sim.lastSwapAt) : "never"} />
                  <Fact label={`${b.wallet} wallet`} value={c.wallet ? <Status value={c.wallet.status} /> : "none"} sub={c.wallet ? `${c.wallet.tier} KYC · ${c.wallet.type === "person" ? "customer" : c.wallet.type}` : undefined} />
                  <Fact label="Balance" value={c.wallet ? ghs(c.wallet.balance) : "–"} />
                </div>
                {c.wallet?.status === "locked" && <p className="mt-3 text-xs text-gray-600">The wallet is locked after wrong PINs. A PIN can only be reset in person: send the customer to a service centre with their Ghana Card.</p>}
              </Section>

              <Section title="Open a ticket" hint="For a wrong transfer or a payment the customer did not make, choose the payment. The dispute then follows the money: on this network you can hold and return it; on another network it goes through the switch.">
                <ActionForm
                  team={team}
                  path={path}
                  action="open_ticket"
                  submit="Open ticket"
                  extra={{ msisdn: c.msisdn }}
                  onDone={refresh}
                  fields={[
                    { name: "category", label: "What is it about", type: "select", options: data.categories.map(([k, l]) => [k, l] as const) },
                    {
                      name: "txnId",
                      label: "Payment complained about",
                      type: "select",
                      options: [["", "No payment involved"], ...c.txns.filter((x) => x.out && x.status === "success" && ["p2p", "merchant", "cashout"].includes(x.type)).map((x) => [x.id, `${ghs(x.amount)} to ${x.to} · ${when(x.at)}`] as const)],
                    },
                    { name: "description", label: "What the customer said", optional: true },
                    { name: "verified", label: "Did the caller answer the security questions correctly?", type: "select", options: [["no", "Not yet"], ["yes", "Yes"]] },
                  ]}
                />
              </Section>

              <Section title="This customer's tickets">
                <Table
                  rows={c.tickets}
                  empty="No tickets for this customer."
                  onRow={(k) => openTicket(k.id)}
                  cols={[
                    { label: "Ticket", cell: (k) => <span className="font-mono text-xs font-semibold">{k.id}</span> },
                    { label: "Opened", cell: (k) => <span className="whitespace-nowrap text-gray-500">{when(k.openedAt)}</span> },
                    { label: "About", cell: (k) => k.category },
                    { label: "Amount", right: true, cell: (k) => (k.amount === null ? "–" : ghs(k.amount)) },
                    { label: "Status", cell: (k) => <Status value={k.status} /> },
                  ]}
                />
              </Section>

              <Section title="Recent transactions" hint="Click a row to see its ledger postings.">
                <TxnTable team={team} rows={c.txns} />
              </Section>
            </>
          )}
        </>
      )}
    </Shell>
  );
}

function Fact({ label, value, sub, mono }: { label: string; value: React.ReactNode; sub?: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 font-medium text-gray-900 ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}
