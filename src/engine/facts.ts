import type { Condition, FactName } from "./config/schemas";
import type { World } from "./world";
import { DAY, HOUR } from "./util";

export type Facts = Record<FactName, number | string | boolean>;

export interface FactInput {
  type: string;
  channel: string;
  fromWallet: string;
  toWallet?: string;
  recipientType: string;
  amount: number; // pesewas
  crossNetwork: boolean;
  newDevice?: boolean;
}

export function computeFacts(w: World, f: FactInput): Facts {
  const db = w.db;
  const now = w.now;
  const sender = db.prepare("SELECT msisdn, balance, kyc_tier, created_at FROM wallets WHERE id = ?").get(f.fromWallet) as
    | { msisdn: string; balance: number; kyc_tier: string; created_at: number }
    | undefined;
  const recipient = f.toWallet
    ? (db.prepare("SELECT msisdn, kyc_tier, created_at FROM wallets WHERE id = ?").get(f.toWallet) as { msisdn: string; kyc_tier: string; created_at: number } | undefined)
    : undefined;

  const num = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n ?? 0);

  let recipientIsNew = true;
  let distinctSenders1h = 0;
  let inbound24h = 0;
  let reported = 0;
  if (recipient && sender) {
    const known =
      num("SELECT COUNT(*) AS n FROM contacts WHERE msisdn = ? AND contact = ?", sender.msisdn, recipient.msisdn) +
      num("SELECT COUNT(*) AS n FROM txns WHERE from_wallet = ? AND to_wallet = ? AND status = 'success' LIMIT 1", f.fromWallet, f.toWallet!);
    recipientIsNew = known === 0;
    distinctSenders1h = num("SELECT COUNT(DISTINCT from_wallet) AS n FROM txns WHERE to_wallet = ? AND created_at > ? AND status IN ('success','held')", f.toWallet!, now - HOUR);
    inbound24h = num("SELECT COUNT(*) AS n FROM txns WHERE to_wallet = ? AND created_at > ? AND status IN ('success','held')", f.toWallet!, now - DAY);
    reported = num("SELECT COUNT(*) AS n FROM fraud_reports r JOIN txns t ON t.id = r.txn_id WHERE t.to_wallet = ?", f.toWallet!);
  }

  const sim = sender ? (db.prepare("SELECT last_swap_at FROM sims WHERE msisdn = ?").get(sender.msisdn) as { last_swap_at: number | null } | undefined) : undefined;
  const balance = sender?.balance ?? 0;

  return {
    amount: f.amount / 100,
    type: f.type,
    channel: f.channel,
    cross_network: f.crossNetwork,
    recipient_is_new: recipientIsNew,
    recipient_type: f.recipientType,
    recipient_account_age_days: recipient ? Math.floor((now - recipient.created_at) / DAY) : 9999,
    recipient_distinct_senders_1h: distinctSenders1h,
    recipient_inbound_count_24h: inbound24h,
    recipient_kyc_tier: recipient?.kyc_tier ?? "n/a",
    sender_kyc_tier: sender?.kyc_tier ?? "n/a",
    sender_balance: balance / 100,
    amount_to_balance_ratio: balance > 0 ? Math.round((f.amount / balance) * 1000) / 1000 : 1,
    sender_txn_count_1h: num("SELECT COUNT(*) AS n FROM txns WHERE from_wallet = ? AND created_at > ?", f.fromWallet, now - HOUR),
    sender_new_recipients_1h: sender
      ? num(
          `SELECT COUNT(DISTINCT t.to_wallet) AS n FROM txns t
           WHERE t.from_wallet = ? AND t.created_at > ? AND t.to_wallet IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.msisdn = ? AND 'w_' || c.contact = t.to_wallet)
             AND NOT EXISTS (SELECT 1 FROM txns p WHERE p.from_wallet = t.from_wallet AND p.to_wallet = t.to_wallet AND p.status = 'success' AND p.created_at < ?)`,
          f.fromWallet,
          now - HOUR,
          sender.msisdn,
          now - HOUR,
        )
      : 0,
    sender_account_age_days: sender ? Math.floor((now - sender.created_at) / DAY) : 0,
    hours_since_sim_swap: sim?.last_swap_at ? Math.floor((now - sim.last_swap_at) / HOUR) : 99999,
    new_device: !!f.newDevice,
    hour_of_day: new Date(now).getUTCHours(),
    recipient_reported_count: reported,
  };
}

export function evaluate(c: Condition, facts: Partial<Facts>): boolean {
  if ("all" in c) return c.all.every((x) => evaluate(x, facts));
  if ("any" in c) return c.any.some((x) => evaluate(x, facts));
  if ("not" in c) return !evaluate(c.not, facts);
  const actual = facts[c.fact];
  if (actual === undefined) return false;
  const v = c.value;
  switch (c.op) {
    case ">":
      return Number(actual) > Number(v);
    case ">=":
      return Number(actual) >= Number(v);
    case "<":
      return Number(actual) < Number(v);
    case "<=":
      return Number(actual) <= Number(v);
    case "==":
      return actual === v || String(actual) === String(v);
    case "!=":
      return !(actual === v || String(actual) === String(v));
    case "in":
      return Array.isArray(v) && v.map(String).includes(String(actual));
  }
}
