"use client";

import { useState } from "react";
import { ActionButton, Activity, Badge, Loading, Section, SettingsForm, SettingsHistory, Shell, Stat, Stats, Status, Table, Tabs, TxnTable, useView, type ActivityRow, type TxnRow } from "@/components/ui";
import { ghs, when } from "@/lib/client";
import { ApiPartners, type ApiPartner } from "./partners";

interface SwitchView {
  participants: { participant: string; name: string; kind: string; connected: boolean; position: number; sent: number; received: number; feesBilled: number; settlesVia: string }[];
  stats: { routed: number; value: number; rejected: number; unsettled: number };
  log: { id: number; txn_id: string | null; step: string; from: string; to: string; detail: string; at: string }[];
  settlements: { id: string; at: string; lines: { name: string; net: number }[] }[];
  txns: TxnRow[];
  disputes: { id: string; from: string; otherId: string; to: string; amount: number; held: number; returned: number; status: string; resolution: string | null; raisedAt: string; updatedAt: string }[];
  config: { feePerTxn: number; maxAmount: number };
  apiPartners: ApiPartner[];
  activity: ActivityRow[];
}

const TABS = [["participants", "Participants and positions"], ["log", "Message log"], ["settlements", "Settlements"], ["txns", "Routed payments"], ["disputes", "Disputes"], ["api", "API partners"], ["settings", "Settings"]] as const;

export default function Switch({ team }: { team: string }) {
  const path = "/s/switch";
  const { data, error, refresh } = useView<SwitchView>(team, path);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("participants");
  const [settled, setSettled] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const s = data.stats;

  return (
    <Shell team={team} title="National switch" subtitle="Interoperability between networks and banks (GhIPSS in real life)" color="#312e81">
      <Stats>
        <Stat label="Payments routed" value={s.routed} sub={ghs(s.value)} />
        <Stat label="Refused by the switch" value={s.rejected} tone={s.rejected ? "bad" : undefined} />
        <Stat label="Waiting for settlement" value={ghs(s.unsettled)} sub="total owed between participants" />
        <Stat label="Participants connected" value={`${data.participants.filter((p) => p.connected).length} / ${data.participants.length}`} />
      </Stats>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "participants" && (
        <>
          <Section
            title="Participants and positions"
            hint="Every payment between two institutions is cleared here at once, but the money behind it moves only at settlement. Until then each participant has a running position: what it owes the others, or is owed."
            right={
              <ActionButton team={team} path={path} body={{ action: "settle" }} dark confirmText="Settle every participant's net position now?" onDone={(r) => { setSettled((r as { message: string }).message); void refresh(); }}>
                Run settlement
              </ActionButton>
            }
          >
            {settled && <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{settled}</p>}
            <Table
              rows={data.participants}
              empty=""
              cols={[
                { label: "Participant", cell: (p) => <span className="font-medium text-gray-900">{p.name}</span> },
                { label: "Type", cell: (p) => <Badge tone={p.kind === "telco" ? "blue" : "gray"}>{p.kind === "telco" ? "e-money issuer" : "bank"}</Badge> },
                { label: "Settles through", cell: (p) => p.settlesVia },
                { label: "Sent", right: true, cell: (p) => p.sent },
                { label: "Received", right: true, cell: (p) => p.received },
                { label: "Position", right: true, cell: (p) => (p.position === 0 ? <span className="text-gray-400">0.00</span> : <span className={p.position > 0 ? "text-red-700" : "text-green-700"}>{p.position > 0 ? `owes ${ghs(p.position)}` : `is owed ${ghs(-p.position)}`}</span>) },
                { label: "Switch fees billed", right: true, cell: (p) => ghs(p.feesBilled) },
                { label: "Link", cell: (p) => <Status value={p.connected ? "connected" : "disconnected"} /> },
                {
                  label: "",
                  cell: (p) => (
                    <ActionButton team={team} path={path} body={{ action: "connect", participant: p.participant, connected: !p.connected }} onDone={refresh} danger={p.connected}>
                      {p.connected ? "Disconnect" : "Connect"}
                    </ActionButton>
                  ),
                },
              ]}
            />
          </Section>
          <Section title="How settlement works here">
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
              <li>A telco does not settle directly. Its position is paid from, or into, its trust account at its partner bank, and that bank takes the obligation on.</li>
              <li>The banks then settle the net amounts across their settlement accounts at the Bank of Ghana.</li>
              <li>After settlement every position is zero, and each telco&apos;s trust account again equals the e-money in its customers&apos; wallets.</li>
            </ul>
          </Section>
        </>
      )}

      {tab === "log" && (
        <Section title="Message log" hint="Each routed payment has three steps: lookup (find the recipient's institution), quote, and commit. A reject shows why the switch refused.">
          <Table
            rows={data.log}
            empty="The switch has not routed anything yet. Send money between two networks, or between a bank and a wallet."
            cols={[
              { label: "Time", cell: (l) => <span className="whitespace-nowrap text-gray-500">{when(l.at)}</span> },
              { label: "Step", cell: (l) => <Status value={l.step} /> },
              { label: "From", cell: (l) => l.from },
              { label: "To", cell: (l) => l.to },
              { label: "Detail", cell: (l) => l.detail },
              { label: "Payment", cell: (l) => <span className="font-mono text-[11px] text-gray-500">{l.txn_id ? l.txn_id.slice(3, 13).toUpperCase() : ""}</span> },
            ]}
          />
        </Section>
      )}

      {tab === "settlements" && (
        <Section title="Settlement runs">
          {data.settlements.length === 0 ? (
            <p className="text-sm text-gray-500">No settlement has been run yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.settlements.map((x) => (
                <li key={x.id} className="py-2 text-sm">
                  <div className="font-medium text-gray-900">
                    {when(x.at)} <span className="font-mono text-xs text-gray-500">{x.id.slice(4, 12).toUpperCase()}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-gray-700">
                    {x.lines.map((l) => (
                      <span key={l.name}>
                        {l.name} <span className={l.net > 0 ? "text-red-700" : "text-green-700"}>{l.net > 0 ? `paid ${ghs(l.net)}` : `received ${ghs(-l.net)}`}</span>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "txns" && (
        <Section title="Routed payments" hint="Click a row to see its ledger postings and the switch messages behind it.">
          <TxnTable team={team} rows={data.txns} empty="Nothing has gone through the switch yet." />
        </Section>
      )}

      {tab === "disputes" && (
        <Section title="Disputes between networks" hint="When a customer disputes a payment to another network, their network raises it here and the recipient's network decides. If money comes back, it is routed through the switch like any other payment.">
          <Table
            rows={data.disputes}
            empty="No network has raised a dispute with another yet."
            cols={[
              { label: "Raised", cell: (d) => <span className="whitespace-nowrap text-gray-500">{when(d.raisedAt)}</span> },
              { label: "Raised by", cell: (d) => (<>{d.from}<div className="font-mono text-[11px] text-gray-500">{d.id}</div></>) },
              { label: "Decided by", cell: (d) => (<>{d.to}<div className="font-mono text-[11px] text-gray-500">{d.otherId}</div></>) },
              { label: "Disputed", right: true, cell: (d) => ghs(d.amount) },
              { label: "On hold", right: true, cell: (d) => (d.held ? ghs(d.held) : "–") },
              { label: "Returned", right: true, cell: (d) => (d.returned ? ghs(d.returned) : "–") },
              { label: "Status", cell: (d) => (<><Status value={d.status} />{d.resolution && <div className="mt-0.5 max-w-[260px] text-[11px] text-gray-500">{d.resolution}</div>}</>) },
            ]}
          />
        </Section>
      )}

      {tab === "api" && (
        <ApiPartners
          team={team}
          path={path}
          partners={data.apiPartners}
          onChange={refresh}
          institution="the national switch"
          apiPath="/ghipss"
          what="The switch gives licensed institutions name enquiry across every bank and network, the list of participants, and the status of routed payments. Payments themselves are sent through the institution's bank or network."
        />
      )}

      {tab === "settings" && (
        <>
          <Section title="Switch rules">
            <SettingsForm
              team={team}
              path={path}
              onSaved={refresh}
              fields={[
                { pointer: "/feePerTxn", label: "Fee per routed payment (GHS)", value: data.config.feePerTxn, hint: "Billed to the sending institution, not to the customer." },
                { pointer: "/maxAmount", label: "Largest single payment (GHS)", value: data.config.maxAmount },
              ]}
            />
          </Section>
          <Section title="Settings history">
            <SettingsHistory team={team} surface="switch" onChange={refresh} />
          </Section>
          <Section title="Activity">
            <Activity rows={data.activity} />
          </Section>
        </>
      )}
    </Shell>
  );
}
