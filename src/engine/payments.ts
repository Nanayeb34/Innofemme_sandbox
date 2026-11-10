import { tx } from "./db";
import { getConfig } from "./config/store";
import type { CheckAction, FeeKind, Rules } from "./config/schemas";
import { computeFacts, evaluate, type Facts } from "./facts";
import { cedis, clock, notify, sendSms } from "./notify";
import type { World } from "./world";
import { DAY, newId, TELCO_INFO, type Telco } from "./util";

export type TxnType = "p2p" | "merchant" | "cashout" | "cashin" | "to_bank" | "from_bank" | "rtp";

/**
 * Who is actually pressing the buttons:
 * - owner: the wallet holder acting for themselves
 * - victim: the wallet holder, manipulated by a scammer
 * - impostor: someone else in control of the wallet (stolen PIN, SIM swap)
 */
export type Actor = "owner" | "victim" | "impostor";

export interface TransferRequest {
  type: TxnType;
  channel: "ussd" | "app" | "api" | "system";
  initiatedBy: "human" | "bot" | "api";
  from?: string;
  to?: string;
  bankAccount?: string;
  amount: number; // pesewas
  reference?: string;
  pin?: string;
  actor?: Actor;
  newDevice?: boolean;
  scenario?: string;
  isFraud?: boolean;
  laundering?: boolean; // moving proceeds between mules, not a victim payment
  warned?: boolean; // already shown a menu warning screen
  acknowledgedWarning?: boolean;
  otp?: string;
  otpShareChance?: number; // impostor only: chance the victim reads out the code
  skipChecks?: boolean;
}

export type TransferStatus = "success" | "failed" | "blocked" | "held" | "abandoned" | "needs_warning_ack" | "needs_otp";

export interface TransferResult {
  status: TransferStatus;
  txnId?: string;
  message: string;
  fee: number;
  warning?: string;
}

export interface WalletRow {
  id: string;
  msisdn: string;
  telco: Telco;
  person_id: string | null;
  owner_type: string;
  display_name: string;
  kyc_tier: "minimum" | "medium" | "enhanced";
  pin: string;
  status: string;
  balance: number;
  created_at: number;
}

export const getWallet = (w: World, id: string) => w.db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined;
export const walletByMsisdn = (w: World, msisdn: string) => w.db.prepare("SELECT * FROM wallets WHERE msisdn = ?").get(msisdn) as WalletRow | undefined;

export function feeFor(rules: Rules, telco: Telco, kind: FeeKind, amount: number): number {
  const cedis = amount / 100;
  const bands = rules.fees[telco][kind].bands;
  const band = bands.find((b) => b.upTo === null || cedis <= b.upTo) ?? bands[bands.length - 1];
  const fee = band.flat * 100 + (amount * band.pct) / 100;
  return Math.round(band.max === undefined ? fee : Math.min(fee, band.max * 100));
}

function feeKind(type: TxnType, crossNetwork: boolean): FeeKind | undefined {
  if (type === "p2p") return crossNetwork ? "p2p_offnet" : "p2p_onnet";
  if (type === "merchant" || type === "rtp") return "merchant";
  if (type === "cashout") return "cashout";
  if (type === "to_bank") return "to_bank";
  return undefined;
}

export function quoteFee(w: World, type: TxnType, from: WalletRow, to: WalletRow | undefined, amount: number) {
  const kind = feeKind(type, !!to && to.telco !== from.telco);
  return kind ? feeFor(getConfig(w.db, "rules"), from.telco, kind, amount) : 0;
}

const PRECEDENCE: CheckAction[] = ["block", "hold", "require_second_factor", "warn", "flag"];

interface Hit {
  id: string;
  name: string;
  action: CheckAction;
  holdMinutes?: number;
  message?: string;
}

async function runChecks(w: World, req: TransferRequest, facts: Facts): Promise<Hit[]> {
  const cfg = getConfig(w.db, "fraudChecks");
  const hits: Hit[] = cfg.checks
    .filter((c) => c.enabled && (c.appliesTo as string[]).includes(req.type) && evaluate(c.when, facts))
    .map((c) => ({ id: c.id, name: c.name, action: c.action, holdMinutes: c.holdMinutes, message: c.message }));

  if (cfg.webhook.enabled && cfg.webhook.url) {
    try {
      const res = await fetch(cfg.webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ world: w.id, at: new Date(w.now).toISOString(), transaction: { type: req.type, channel: req.channel, from: req.from, to: req.to, amount: req.amount / 100 }, facts }),
        signal: AbortSignal.timeout(cfg.webhook.timeoutMs),
      });
      const body = (await res.json()) as { action?: string; reason?: string; holdMinutes?: number };
      if (body.action && (PRECEDENCE as string[]).includes(body.action)) {
        hits.push({ id: "webhook", name: body.reason ?? "Team model", action: body.action as CheckAction, holdMinutes: body.holdMinutes });
      }
    } catch {
      if (!cfg.webhook.failOpen) hits.push({ id: "webhook", name: "Team model unavailable (fail closed)", action: "block" });
    }
  }
  return hits;
}

/** Writes balanced ledger postings and applies them to wallet and bank balances. */
function post(w: World, txnId: string, entries: [string, number][]) {
  const sum = entries.reduce((s, [, a]) => s + a, 0);
  if (sum !== 0) throw new Error(`unbalanced postings for ${txnId}: ${sum}`);
  const ins = w.db.prepare("INSERT INTO postings(txn_id, account, amount, at) VALUES(?,?,?,?)");
  const updW = w.db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?");
  const updB = w.db.prepare("UPDATE bank_accounts SET balance = balance + ? WHERE id = ?");
  for (const [account, amount] of entries) {
    if (amount === 0) continue;
    ins.run(txnId, account, amount, w.now);
    if (account.startsWith("w:")) updW.run(amount, account.slice(2));
    else if (account.startsWith("bank:")) updB.run(amount, account.slice(5));
  }
}

function switchLog(w: World, txnId: string, step: string, from: string | null, to: string | null, detail: string) {
  w.db.prepare("INSERT INTO switch_log(txn_id, step, from_telco, to_telco, detail, at) VALUES(?,?,?,?,?,?)").run(txnId, step, from, to, detail, w.now);
}

interface TxnRow {
  id: string;
  type: string;
  from_wallet: string | null;
  to_wallet: string | null;
  bank_account: string | null;
  from_telco: string | null;
  to_telco: string | null;
  rail: string;
  amount: number;
  fee: number;
  reference: string | null;
}

/** Moves money for a txn whose funds are either in the sender's wallet or in the telco hold account. */
function settle(w: World, t: TxnRow, fromHold: boolean) {
  const source = fromHold ? `hold:${t.from_telco}` : `w:${t.from_wallet}`;
  const entries: [string, number][] = [];
  if (t.type === "from_bank") {
    entries.push([`bank:${t.bank_account}`, -t.amount], [`w:${t.to_wallet}`, t.amount]);
  } else if (t.type === "cashin") {
    entries.push([`w:${t.from_wallet}`, -t.amount], [`w:${t.to_wallet}`, t.amount]);
  } else {
    entries.push([source, -(t.amount + t.fee)]);
    if (t.fee) entries.push([`fee:${t.from_telco}`, t.fee]);
    if (t.rail === "bank") entries.push([`bank:${t.bank_account}`, t.amount]);
    else if (t.rail === "switch") entries.push([`switch:${t.from_telco}`, t.amount], [`switch:${t.to_telco}`, -t.amount], [`w:${t.to_wallet}`, t.amount]);
    else entries.push([`w:${t.to_wallet}`, t.amount]);
  }
  post(w, t.id, entries);
  if (t.rail === "switch" || t.rail === "bank") switchLog(w, t.id, "commit", t.from_telco, t.to_telco, `settled ${cedis(t.amount)}`);
  if (t.type === "cashout") w.db.prepare("UPDATE agents SET cash = cash - ? WHERE wallet_id = ?").run(t.amount, t.to_wallet);
  if (t.type === "cashin") w.db.prepare("UPDATE agents SET cash = cash + ? WHERE wallet_id = ?").run(t.amount, t.from_wallet);
}

function sentNotifications(w: World, t: TxnRow) {
  const from = t.from_wallet ? getWallet(w, t.from_wallet) : undefined;
  const to = t.to_wallet ? getWallet(w, t.to_wallet) : undefined;
  const bank = t.bank_account ? (w.db.prepare("SELECT name, bank FROM bank_accounts WHERE id = ?").get(t.bank_account) as { name: string; bank: string }) : undefined;
  const base = { amount: cedis(t.amount), fee: cedis(t.fee), reference: t.reference ?? "", txn_id: t.id.slice(3, 13).toUpperCase(), time: clock(w.now) };
  if (from && t.type !== "cashin") {
    const event = t.type === "cashout" ? "cashout" : t.type === "merchant" || t.type === "rtp" ? "merchant_payment" : "transfer_sent";
    notify(w, event, from.msisdn, { ...base, counterparty: to?.msisdn ?? bank?.bank ?? "", counterparty_name: to?.display_name ?? bank?.name ?? "", balance: cedis(from.balance) });
  }
  if (to && t.type !== "cashout") {
    const vars = { ...base, counterparty: from?.msisdn ?? bank?.bank ?? "", counterparty_name: from?.display_name ?? bank?.name ?? "", balance: cedis(to.balance) };
    notify(w, "transfer_received", to.msisdn, vars);
    if (t.amount >= 100_000) notify(w, "large_inbound", to.msisdn, vars);
  }
}

export async function transfer(w: World, req: TransferRequest): Promise<TransferResult> {
  const db = w.db;
  const rules = getConfig(db, "rules");
  const from = req.from ? getWallet(w, req.from) : undefined;
  const to = req.to ? getWallet(w, req.to) : undefined;
  const bank = req.bankAccount ? (db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(req.bankAccount) as { id: string; name: string; bank: string } | undefined) : undefined;
  const fail = (message: string): TransferResult => ({ status: "failed", message, fee: 0 });

  if (!Number.isInteger(req.amount) || req.amount <= 0) return fail("Invalid amount");
  if (req.type !== "from_bank" && !from) return fail("Sender wallet not found");
  if (["p2p", "merchant", "cashout", "cashin", "rtp", "from_bank"].includes(req.type) && !to) return fail("Recipient is not registered for mobile money");
  if ((req.type === "to_bank" || req.type === "from_bank") && !bank) return fail("Bank account not found");
  if (from && from.status !== "active") return fail(`Wallet is ${from.status}. Contact customer care.`);
  if (to && to.status === "blacklisted") return fail("Recipient wallet cannot receive payments");
  if (from && to && from.id === to.id) return fail("You cannot send to yourself");
  if (req.pin !== undefined && from && req.pin !== from.pin) return fail("Wrong PIN");

  const crossNetwork = !!from && !!to && from.telco !== to.telco;
  const rail = req.type === "to_bank" || req.type === "from_bank" ? "bank" : crossNetwork ? "switch" : "onnet";
  const fee = from ? quoteFee(w, req.type, from, to, req.amount) : 0;

  // Bank of Ghana KYC tier limits.
  if (from && !req.skipChecks) {
    const tier = rules.kycTiers[from.kyc_tier];
    const dayStart = w.now - (w.now % DAY);
    const monthStart = Date.UTC(new Date(w.now).getUTCFullYear(), new Date(w.now).getUTCMonth(), 1);
    const outSince = (since: number) =>
      Number((db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM txns WHERE from_wallet = ? AND created_at >= ? AND status IN ('success','held')").get(from.id, since) as { n: number }).n);
    if (outSince(dayStart) + req.amount > tier.daily * 100) return fail(`Exceeds your daily limit of GHS ${tier.daily}`);
    if (tier.monthly !== null && outSince(monthStart) + req.amount > tier.monthly * 100) return fail(`Exceeds your monthly limit of GHS ${tier.monthly}`);
  }
  if (to && req.type !== "cashin") {
    const tier = rules.kycTiers[to.kyc_tier];
    if (to.balance + req.amount > tier.maxBalance * 100) return fail("Recipient wallet limit reached");
  }
  if (from && req.type !== "cashin" && from.balance < req.amount + fee) return fail("Insufficient balance");
  if (req.type === "cashin" && from && from.balance < req.amount) return fail("Agent has insufficient float");
  if (req.type === "cashout" && to) {
    const agent = db.prepare("SELECT cash FROM agents WHERE wallet_id = ?").get(to.id) as { cash: number } | undefined;
    if (!agent) return fail("Not a registered agent");
    if (agent.cash < req.amount) return fail("Agent does not have enough cash");
  }

  const txnId = newId("tx");
  if (rail !== "onnet") {
    switchLog(w, txnId, "lookup", from?.telco ?? null, to?.telco ?? (bank ? "bank" : null), to ? `${to.msisdn} → ${TELCO_INFO[to.telco].name}` : `${bank!.bank}`);
    switchLog(w, txnId, "quote", from?.telco ?? null, to?.telco ?? "bank", `amount ${cedis(req.amount)} fee ${cedis(fee)}`);
  }

  // Fraud checks.
  let hits: Hit[] = [];
  let facts: Facts | undefined;
  if (from && !req.skipChecks && req.type !== "cashin") {
    facts = computeFacts(w, {
      type: req.type,
      channel: req.channel,
      fromWallet: from.id,
      toWallet: to?.id,
      recipientType: to?.owner_type ?? "bank",
      amount: req.amount,
      crossNetwork,
      newDevice: req.newDevice,
    });
    hits = await runChecks(w, req, facts);
  }
  const top = PRECEDENCE.find((a) => hits.some((h) => h.action === a));
  const topHit = top ? hits.find((h) => h.action === top) : undefined;
  const actor = req.actor ?? "owner";
  let warned = req.warned || req.acknowledgedWarning ? 1 : 0;
  let secondFactor = 0;
  let status: "success" | "blocked" | "held" | "abandoned" | "failed" = "success";
  let reason: string | undefined;
  let releaseAt: number | null = null;

  if (top === "block") {
    status = "blocked";
    reason = topHit!.name;
  } else if (top === "require_second_factor") {
    secondFactor = 1;
    if (req.initiatedBy === "human") {
      if (!req.otp) {
        const code = String(w.rng.int(100000, 999999));
        w.otps.set(from!.msisdn, code);
        sendSms(w, from!.msisdn, "MoMoSecure", `Your verification code is ${code}. Never share this code with anyone, including staff.`);
        return { status: "needs_otp", message: "Enter the code sent to you by SMS", fee };
      }
      if (w.otps.get(from!.msisdn) !== req.otp) return fail("Wrong verification code");
      w.otps.delete(from!.msisdn);
    } else if (actor === "impostor") {
      if (!w.rng.chance(req.otpShareChance ?? 0)) {
        status = "blocked";
        reason = `Second factor failed (${topHit!.name})`;
      }
    } else if (actor === "owner" && w.rng.chance(0.03)) {
      status = "abandoned";
      reason = "Gave up at second factor";
    }
  } else if (top === "warn") {
    const message = topHit!.message ?? "WARNING: Scammers pretend to be MoMo staff or say they sent money by mistake. Do you know this person?";
    if (req.initiatedBy === "human") {
      if (!req.acknowledgedWarning) return { status: "needs_warning_ack", message, fee, warning: message };
    } else if (actor !== "impostor") {
      warned = 1;
      if (w.rng.chance(actor === "victim" ? 0.55 : 0.04)) {
        status = "abandoned";
        reason = `Cancelled after warning (${topHit!.name})`;
      }
    }
  }
  if (status === "success" && top === "hold") {
    status = "held";
    reason = topHit!.name;
    releaseAt = w.now + (topHit!.holdMinutes ?? 30) * 60_000;
  }

  const row: TxnRow = {
    id: txnId,
    type: req.type,
    from_wallet: from?.id ?? null,
    to_wallet: to?.id ?? null,
    bank_account: bank?.id ?? null,
    from_telco: from?.telco ?? null,
    to_telco: to?.telco ?? (bank ? "bank" : null),
    rail,
    amount: req.amount,
    fee: status === "success" || status === "held" ? fee : 0,
    reference: req.reference ?? null,
  };

  tx(db, () => {
    db.prepare(
      `INSERT INTO txns(id, type, channel, initiated_by, from_wallet, to_wallet, bank_account, from_telco, to_telco, rail, amount, fee, status, reason, reference,
        created_at, settled_at, release_at, warned, second_factor, checks, scenario, is_fraud) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.type, req.channel, req.initiatedBy, row.from_wallet, row.to_wallet, row.bank_account, row.from_telco, row.to_telco, row.rail,
      row.amount, row.fee, status, reason ?? null, row.reference, w.now, status === "success" ? w.now : null, releaseAt, warned, secondFactor,
      hits.length ? JSON.stringify(hits.map((h) => ({ id: h.id, name: h.name, action: h.action }))) : null, req.scenario ?? null, req.isFraud ? (req.laundering ? 2 : 1) : 0,
    );
    if (status === "success") {
      settle(w, row, false);
      sentNotifications(w, row);
    } else if (status === "held") {
      post(w, row.id, [[`w:${row.from_wallet}`, -(row.amount + row.fee)], [`hold:${row.from_telco}`, row.amount + row.fee]]);
      notify(w, "held", from!.msisdn, { amount: cedis(row.amount), counterparty: to?.msisdn ?? bank?.bank, release_time: clock(releaseAt!) });
    } else if (status === "blocked") {
      if (rail !== "onnet") switchLog(w, txnId, "reject", row.from_telco, row.to_telco, reason ?? "");
      notify(w, "blocked", from!.msisdn, { amount: cedis(row.amount), counterparty: to?.msisdn ?? bank?.bank });
    }
    if (warned && from && status !== "abandoned") notify(w, "warned", from.msisdn, { amount: cedis(row.amount), counterparty: to?.msisdn ?? bank?.bank });
  });

  const messages: Record<string, string> = {
    success: `Payment of GHS ${cedis(req.amount)} sent${to ? ` to ${to.display_name}` : ""}. Fee GHS ${cedis(row.fee)}.`,
    held: `Your transfer is on hold until ${clock(releaseAt ?? 0)} for your safety.`,
    blocked: `Transaction blocked for your safety.`,
    abandoned: `Transaction cancelled.`,
  };
  return { status, txnId, message: messages[status] ?? reason ?? "", fee: row.fee };
}

/** Releases held funds whose cooling-off period has ended. */
export function releaseHolds(w: World) {
  const due = w.db.prepare("SELECT * FROM txns WHERE status = 'held' AND release_at <= ?").all(w.now) as unknown as TxnRow[];
  for (const t of due) {
    tx(w.db, () => {
      const to = t.to_wallet ? getWallet(w, t.to_wallet) : undefined;
      if (to && to.status !== "active") {
        reverseHeld(w, t.id, "Recipient wallet no longer active");
        return;
      }
      settle(w, t, true);
      w.db.prepare("UPDATE txns SET status = 'success', settled_at = ? WHERE id = ?").run(w.now, t.id);
      sentNotifications(w, t);
    });
  }
}

/** Returns held funds to the sender, e.g. when the victim reports the transfer during the hold. */
export function reverseHeld(w: World, txnId: string, reason: string): boolean {
  const t = w.db.prepare("SELECT * FROM txns WHERE id = ? AND status = 'held'").get(txnId) as TxnRow | undefined;
  if (!t) return false;
  tx(w.db, () => {
    post(w, t.id, [[`hold:${t.from_telco}`, -(t.amount + t.fee)], [`w:${t.from_wallet}`, t.amount + t.fee]]);
    w.db.prepare("UPDATE txns SET status = 'reversed', reason = ?, settled_at = ? WHERE id = ?").run(reason, w.now, t.id);
  });
  return true;
}

export function reportFraud(w: World, txnId: string, reporterMsisdn: string, category: string) {
  w.db.prepare("INSERT INTO fraud_reports(txn_id, reporter_msisdn, category, at) VALUES(?,?,?,?)").run(txnId, reporterMsisdn, category, w.now);
  const rules = getConfig(w.db, "rules");
  if (rules.victimCanReverseHeldFunds) return reverseHeld(w, txnId, "Reported by sender during hold");
  return false;
}
