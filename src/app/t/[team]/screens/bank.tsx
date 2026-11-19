"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton, ActionForm, Activity, Badge, ID_FIELDS, Loading, Section, SettingsHistory, SettingsJson, Shell, Stat, Stats, Status, Table, Tabs, TxnTable, useView, type ActivityRow, type TxnRow } from "@/components/ui";
import { ghs } from "@/lib/client";
import { ApiPartners, type ApiPartner } from "./partners";

interface BankView {
  bank: string;
  name: string;
  banks: { id: string; name: string }[];
  stats: { accounts: number; deposits: number; trustHeld: number; vaultCash: number; settlementAccount: number; switchPosition: number; feeIncome: number };
  accounts: { id: string; accountNo: string; name: string; kind: string; telco: string | null; status: string; balance: number; card: string | null }[];
  txns: TxnRow[];
  activity: ActivityRow[];
  config: { fees: unknown };
  apiPartners: ApiPartner[];
}

const TABS = [["counter", "Counter"], ["transfers", "Transfers and agent float"], ["accounts", "Accounts"], ["txns", "Transactions"], ["api", "API partners"], ["settings", "Settings"]] as const;

export default function Bank({ team, bank }: { team: string; bank: string }) {
  const path = `/s/bank/${bank}`;
  const { data, error, refresh } = useView<BankView>(team, path);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("counter");
  const router = useRouter();
  if (!data) return <Loading error={error} />;
  const s = data.stats;
  const personal = data.accounts.filter((a) => a.kind === "personal" && a.status === "active");
  const accountOptions = personal.map((a) => [a.id, `${a.name} · ${a.accountNo} · ${ghs(a.balance)}`] as const);
  const none = personal.length === 0 ? "Open an account first." : undefined;
  const amount = { name: "amount", label: "Amount (GHS)", type: "number" as const };

  return (
    <Shell
      team={team}
      title={data.name}
      subtitle="Bank"
      color="#134e4a"
      right={
        <select value={bank} onChange={(e) => router.push(`/t/${team}/bank/${e.target.value}`)} className="rounded-lg border border-white/30 bg-transparent px-2 py-1.5 text-sm" aria-label="Switch bank">
          {data.banks.map((b) => (
            <option key={b.id} value={b.id} className="text-gray-900">
              {b.name}
            </option>
          ))}
        </select>
      }
    >
      <Stats>
        <Stat label="Customer accounts" value={s.accounts} sub={`${ghs(s.deposits)} in deposits`} />
        <Stat label="Telco trust accounts" value={ghs(s.trustHeld)} sub="e-money float held here" />
        <Stat label="Cash in the vault" value={ghs(s.vaultCash)} />
        <Stat label="Settlement account" value={ghs(s.settlementAccount)} sub="at the Bank of Ghana" tone={s.settlementAccount < 0 ? "bad" : undefined} />
        <Stat label="Switch position" value={ghs(Math.abs(s.switchPosition))} sub={s.switchPosition > 0 ? "owed to others" : s.switchPosition < 0 ? "owed to us, unsettled" : "settled"} />
        <Stat label="Fee income" value={ghs(s.feeIncome)} />
      </Stats>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === "counter" && (
        <>
          <Section title="Open an account" hint="The customer's Ghana Card and fingerprint are checked with NIA. One account per person at each bank.">
            <ActionForm team={team} path={path} action="open_account" submit="Verify with NIA and open account" onDone={refresh} fields={ID_FIELDS} />
          </Section>
          <Section title="Cash deposit" hint="This is how money first enters the world: someone brings cash to a bank.">
            <ActionForm team={team} path={path} action="deposit" submit="Deposit" onDone={refresh} disabled={none} fields={[{ name: "account", label: "Account", type: "select", options: accountOptions }, amount]} />
          </Section>
          <Section title="Cash withdrawal">
            <ActionForm team={team} path={path} action="withdraw" submit="Withdraw" onDone={refresh} disabled={none} fields={[{ name: "account", label: "Account", type: "select", options: accountOptions }, amount]} />
          </Section>
        </>
      )}

      {tab === "transfers" && (
        <>
          <Section title="Send to a mobile money wallet" hint="Goes through the national switch to the wallet's network. This is also how a mobile money agent buys float: send to the agent line. Paying in cash over the counter has no fee.">
            <ActionForm
              team={team}
              path={path}
              action="to_wallet"
              submit="Send to wallet"
              onDone={refresh}
              fields={[
                { name: "account", label: "Pay from", type: "select", options: [["", "Cash over the counter"], ...accountOptions] },
                { name: "msisdn", label: "Mobile money number", placeholder: "Any network" },
                amount,
                { name: "reference", label: "Reference", optional: true, placeholder: "Float purchase" },
              ]}
            />
          </Section>
          <Section title="Send to a bank account" hint="To an account at this bank it is an internal transfer. To another bank it goes through the national switch.">
            <ActionForm
              team={team}
              path={path}
              action="transfer"
              submit="Send"
              onDone={refresh}
              disabled={none}
              fields={[{ name: "account", label: "Pay from", type: "select", options: accountOptions }, { name: "toAccountNo", label: "Destination account number", placeholder: "13 digits, any bank" }, amount, { name: "reference", label: "Reference", optional: true }]}
            />
          </Section>
        </>
      )}

      {tab === "accounts" && (
        <Section title="Accounts" hint="Customers' accounts, and the trust accounts in which telcos keep the money that backs their customers' e-money. Trust balances change only when the national switch settles.">
          <Table
            rows={data.accounts}
            empty="No accounts yet."
            cols={[
              { label: "Account no.", cell: (a) => <span className="font-mono text-xs">{a.accountNo}</span> },
              { label: "Name", cell: (a) => a.name },
              { label: "Type", cell: (a) => (a.kind === "trust" ? <Badge tone="blue">trust</Badge> : <Badge>personal</Badge>) },
              { label: "Ghana Card", cell: (a) => <span className="font-mono text-xs">{a.card ?? "–"}</span> },
              { label: "Balance", right: true, cell: (a) => ghs(a.balance) },
              { label: "Status", cell: (a) => <Status value={a.status} /> },
              {
                label: "",
                cell: (a) =>
                  a.kind === "personal" ? (
                    <ActionButton team={team} path={path} body={{ action: "account_status", account: a.id, status: a.status === "active" ? "frozen" : "active" }} onDone={refresh} danger={a.status === "active"}>
                      {a.status === "active" ? "Freeze" : "Unfreeze"}
                    </ActionButton>
                  ) : null,
              },
            ]}
          />
          <p className="mt-3 text-xs text-gray-500">
            Other banks:{" "}
            {data.banks.filter((b) => b.id !== bank).map((b, i) => (
              <span key={b.id}>
                {i > 0 && " · "}
                <Link className="underline" href={`/t/${team}/bank/${b.id}`}>
                  {b.name}
                </Link>
              </span>
            ))}
          </p>
        </Section>
      )}

      {tab === "txns" && (
        <Section title="Transactions" hint="Click a row to see its ledger postings and switch messages.">
          <TxnTable team={team} rows={data.txns} />
        </Section>
      )}

      {tab === "api" && (
        <ApiPartners
          team={team}
          path={path}
          partners={data.apiPartners}
          onChange={refresh}
          institution={data.name}
          apiPath={`/bank/${bank}`}
          what="This is what a bank gives a business customer to run its own account from software: balance, statement, name enquiry, and transfers to bank accounts and wallets."
          link={{ name: "accountNo", label: "The company's account at this bank", type: "select", options: personal.map((a) => [a.accountNo, `${a.name} · ${a.accountNo}`] as const), hint: "Every API call acts on this account." }}
        />
      )}

      {tab === "settings" && (
        <>
          <Section title="Fees" hint="'toWallet' is charged on transfers from an account to a mobile money wallet; 'interbank' on transfers to another bank. Amount bands in GHS: fee = flat + pct% of the amount, capped at 'max'.">
            <SettingsJson team={team} path={path} pointer="/fees" value={data.config.fees} onSaved={refresh} rows={10} />
          </Section>
          <Section title="Settings history">
            <SettingsHistory team={team} surface={`bank.${bank}`} onChange={refresh} />
          </Section>
          <Section title="Activity">
            <Activity rows={data.activity} />
          </Section>
        </>
      )}
    </Shell>
  );
}
