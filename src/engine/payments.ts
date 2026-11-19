import { getConfig } from "./config/store";
import type { FeeKind } from "./config/schemas";
import { count, tx } from "./db";
import { accountByNumber, checkPin, feeFor, getAccount, getTxn, getWallet, insertTxn, post, walletByMsisdn, type AccountRow, type TxnRow, type WalletRow } from "./ledger";
import { notify } from "./notify";
import { commit, positionEntries, route } from "./switch";
import { DAY, HOUR, SimError, TELCO_INFO, bankName, cedis, newId, type Telco } from "./util";
import { audit, type World } from "./world";

/** Every way money moves: wallet payments, agent cash-in and cash-out, bank transfers and teller cash. */

export interface Receipt {
  txnId: string;
  fee: number;
  commission: number;
  message: string;
}

const shortId = (id: string) => id.slice(3, 13).toUpperCase();

/** Records a refused payment so the institution can see it, then reports why. */
function refuse(w: World, t: Partial<TxnRow> & Pick<TxnRow, "type" | "channel" | "rail" | "amount">, reason: string, id = newId("tx")): never {
  insertTxn(w, { ...t, id, status: "failed", reason });
  throw new SimError(reason);
}

function simOf(w: World, msisdn: string) {
  return w.db.prepare("SELECT status, last_swap_at FROM sims WHERE msisdn = ?").get(msisdn) as { status: string; last_swap_at: number | null } | undefined;
}

/** Bank of Ghana KYC tier limits. Agent and merchant wallets are business wallets and are not capped here. */
function checkSendLimits(w: World, from: WalletRow, amount: number): string | undefined {
  if (from.owner_type !== "person") return;
  const tier = getConfig(w.db, "bog").kycTiers[from.kyc_tier];
  const d = new Date(w.now);
  const dayStart = w.now - (w.now % DAY);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const outSince = (since: number) =>
    Number((w.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM txns WHERE from_wallet = ? AND created_at >= ? AND status = 'success' AND type != 'reversal'").get(from.id, since) as { n: number }).n);
  if (outSince(dayStart) + amount > tier.daily * 100) return `Exceeds your daily limit of GHS ${tier.daily} (${from.kyc_tier} KYC)`;
  if (tier.monthly !== null && outSince(monthStart) + amount > tier.monthly * 100) return `Exceeds your monthly limit of GHS ${tier.monthly} (${from.kyc_tier} KYC)`;
}

function checkReceiveLimit(w: World, to: WalletRow, amount: number): string | undefined {
  if (to.owner_type !== "person") return;
  const tier = getConfig(w.db, "bog").kycTiers[to.kyc_tier];
  if (to.balance + amount > tier.maxBalance * 100) return `Recipient wallet would exceed its balance limit of GHS ${tier.maxBalance} (${to.kyc_tier} KYC)`;
}

function senderProblem(w: World, from: WalletRow): string | undefined {
  if (from.status === "frozen") return "Wallet is frozen. Contact customer care.";
  if (from.status === "locked") return "Wallet is locked after too many wrong PINs. Visit a service centre to reset your PIN.";
  const sim = simOf(w, from.msisdn);
  if (!sim || sim.status !== "active") return "This SIM is not active";
  const hold = getConfig(w.db, `telco.${from.telco}`).simSwapMomoHoldHours;
  if (hold && sim.last_swap_at && w.now - sim.last_swap_at < hold * HOUR) return `This number had a SIM replacement recently. Sending money is paused for ${hold} hours after a SIM swap.`;
}

/** Wallet-to-bank fee. Moving money to your own bank account is free; sending to anyone else's is charged. */
export function toBankFee(w: World, from: WalletRow, acct: AccountRow, amount: number) {
  const cfg = getConfig(w.db, `telco.${from.telco}`);
  const own = !!acct.person_id && acct.person_id === from.person_id;
  return own && cfg.ownBankAccountFree !== false ? 0 : feeFor(cfg.fees.to_bank, amount);
}

export interface WalletPayment {
  type: "p2p" | "merchant" | "cashin" | "cashout" | "float";
  channel: "ussd" | "agent" | "api" | "console";
  from: string; // wallet id
  to: string; // wallet id
  amount: number; // pesewas
  pin?: string; // checked when given
  reference?: string;
  /** No fee is charged, e.g. when a business gives a customer their money back. */
  waiveFee?: boolean;
}

/** A payment from one wallet to another: person to person, to a merchant, or between a customer and an agent. */
export function walletPay(w: World, req: WalletPayment): Receipt {
  const from = getWallet(w, req.from);
  const to = getWallet(w, req.to);
  if (!from) throw new SimError("Sender wallet not found");
  if (!to) throw new SimError("Recipient is not registered for mobile money");
  if (!Number.isInteger(req.amount) || req.amount <= 0) throw new SimError("Invalid amount");
  const cfg = getConfig(w.db, `telco.${from.telco}`);
  if (req.pin !== undefined) checkPin(w, from, req.pin, cfg.pinAttemptsBeforeLock);

  const cross = from.telco !== to.telco;
  const id = newId("tx");
  const base = { type: req.type, channel: req.channel, from_wallet: from.id, to_wallet: to.id, from_party: from.telco, to_party: to.telco, rail: cross ? "switch" : "onnet", amount: req.amount, reference: req.reference ?? null };
  const no = (why: string) => refuse(w, base, why, id);

  if (from.id === to.id) no("You cannot send to yourself");
  const problem = senderProblem(w, from);
  if (problem) no(problem);
  if (to.status === "frozen") no("Recipient wallet cannot receive payments");

  let agent: { wallet_id: string; cash: number; status: string; name: string } | undefined;
  if (req.type === "cashin" || req.type === "cashout") {
    const agentWallet = req.type === "cashin" ? from : to;
    agent = w.db.prepare("SELECT wallet_id, cash, status, name FROM momo_agents WHERE wallet_id = ?").get(agentWallet.id) as typeof agent;
    if (!agent) no("Not a registered mobile money agent");
    if (agent!.status !== "active") no("This agent is suspended");
    if (cross) no(`This agent serves ${TELCO_INFO[agentWallet.telco].wallet} customers only`);
    if (req.type === "cashout" && agent!.cash < req.amount) no("The agent does not have enough cash in the till");
  }
  if (req.type === "merchant" && to.owner_type !== "merchant") no("Not a registered merchant");
  if (req.type === "float") {
    // Agents rebalance by moving float between their agent lines.
    if (from.owner_type !== "agent" || to.owner_type !== "agent") no("Float can only move between mobile money agents");
    if (cross) no("Float can only move between agents on the same network");
  }

  const kind: FeeKind | undefined = req.type === "p2p" ? (cross ? "p2p_offnet" : "p2p_onnet") : req.type === "merchant" ? "merchant" : req.type === "cashout" ? "cashout" : undefined;
  const fee = kind && !req.waiveFee ? feeFor(cfg.fees[kind], req.amount) : 0;
  const limit = checkSendLimits(w, from, req.amount) ?? checkReceiveLimit(w, to, req.amount);
  if (limit) no(limit);
  if (from.balance < req.amount + fee) no(req.type === "cashin" ? "Agent has insufficient float" : "Insufficient balance");

  if (cross) {
    try {
      route(w, id, from.telco, to.telco, req.amount, to.msisdn);
    } catch (e) {
      no((e as Error).message);
    }
  }

  const commission = req.type === "cashin" ? feeFor(cfg.agentCommission.cashin, req.amount) : req.type === "cashout" ? feeFor(cfg.agentCommission.cashout, req.amount) : 0;

  tx(w.db, () => {
    insertTxn(w, { ...base, id, fee, commission, status: "success" });
    const entries: [string, number][] = [[`w:${from.id}`, -(req.amount + fee)], [`fee:${from.telco}`, fee], [`w:${to.id}`, req.amount]];
    if (cross) entries.push(...positionEntries(from.telco, to.telco, req.amount));
    if (commission) entries.push([`fee:${from.telco}`, -commission], [`w:${agent!.wallet_id}`, commission]);
    post(w, id, entries);
    if (cross) commit(w, id, from.telco, to.telco, req.amount);
    if (req.type === "cashin") w.db.prepare("UPDATE momo_agents SET cash = cash + ?, commission = commission + ? WHERE wallet_id = ?").run(req.amount, commission, agent!.wallet_id);
    if (req.type === "cashout") w.db.prepare("UPDATE momo_agents SET cash = cash - ?, commission = commission + ? WHERE wallet_id = ?").run(req.amount, commission, agent!.wallet_id);

    const f = getWallet(w, from.id)!;
    const t = getWallet(w, to.id)!;
    const common = { amount: cedis(req.amount), fee: cedis(fee), commission: cedis(commission), reference: req.reference ?? "", txn_id: shortId(id) };
    const toSender = { ...common, counterparty: t.msisdn, counterparty_name: t.display_name, balance: cedis(f.balance) };
    const toRecipient = { ...common, counterparty: f.msisdn, counterparty_name: f.display_name, balance: cedis(t.balance) };
    if (req.type === "cashin") {
      notify(w, f.telco, "agent_cashin", f.msisdn, toSender);
      notify(w, t.telco, "cashin", t.msisdn, toRecipient);
    } else if (req.type === "cashout") {
      notify(w, f.telco, "cashout", f.msisdn, toSender);
      notify(w, t.telco, "agent_cashout", t.msisdn, toRecipient);
    } else {
      notify(w, f.telco, req.type === "merchant" ? "merchant_payment" : "transfer_sent", f.msisdn, toSender);
      notify(w, t.telco, "transfer_received", t.msisdn, toRecipient);
    }
  });

  const verb = req.type === "cashin" ? "deposited to" : req.type === "cashout" ? "cashed out at" : req.type === "merchant" ? "paid to" : req.type === "float" ? "float moved to" : "sent to";
  return { txnId: id, fee, commission, message: `GHS ${cedis(req.amount)} ${verb} ${to.display_name}. Fee GHS ${cedis(fee)}. Trans ID ${shortId(id)}.` };
}

/** Wallet to bank account, through the national switch. */
export function walletToBank(w: World, req: { from: string; accountNo: string; amount: number; pin?: string; reference?: string; channel: "ussd" | "api" | "console" }): Receipt {
  const from = getWallet(w, req.from);
  if (!from) throw new SimError("Sender wallet not found");
  const acct = accountByNumber(w, req.accountNo);
  if (!acct || acct.kind !== "personal") throw new SimError("Bank account not found");
  if (!Number.isInteger(req.amount) || req.amount <= 0) throw new SimError("Invalid amount");
  const cfg = getConfig(w.db, `telco.${from.telco}`);
  if (req.pin !== undefined) checkPin(w, from, req.pin, cfg.pinAttemptsBeforeLock);

  const id = newId("tx");
  const base = { type: "wallet_to_bank", channel: req.channel, from_wallet: from.id, to_account: acct.id, from_party: from.telco, to_party: acct.bank, rail: "switch", amount: req.amount, reference: req.reference ?? null };
  const no = (why: string) => refuse(w, base, why, id);
  const problem = senderProblem(w, from);
  if (problem) no(problem);
  if (acct.status !== "active") no("The bank account cannot receive payments");
  const fee = toBankFee(w, from, acct, req.amount);
  const limit = checkSendLimits(w, from, req.amount);
  if (limit) no(limit);
  if (from.balance < req.amount + fee) no("Insufficient balance");
  try {
    route(w, id, from.telco, acct.bank, req.amount, `account ${acct.account_no}`);
  } catch (e) {
    no((e as Error).message);
  }

  tx(w.db, () => {
    insertTxn(w, { ...base, id, fee, status: "success" });
    post(w, id, [[`w:${from.id}`, -(req.amount + fee)], [`fee:${from.telco}`, fee], ...positionEntries(from.telco, acct.bank, req.amount), [`bank:${acct.id}`, req.amount]]);
    commit(w, id, from.telco, acct.bank, req.amount);
    notify(w, from.telco, "transfer_sent", from.msisdn, { amount: cedis(req.amount), fee: cedis(fee), counterparty: bankName(acct.bank), counterparty_name: acct.name, balance: cedis(getWallet(w, from.id)!.balance), reference: req.reference ?? "", txn_id: shortId(id) });
  });
  return { txnId: id, fee, commission: 0, message: `GHS ${cedis(req.amount)} sent to ${acct.name} (${bankName(acct.bank)}). Fee GHS ${cedis(fee)}. Trans ID ${shortId(id)}.` };
}

function bankSource(w: World, bank: string, accountId: string | undefined): AccountRow | undefined {
  if (!accountId) return undefined; // cash over the counter
  const a = getAccount(w, accountId);
  if (!a || a.bank !== bank) throw new SimError("Source account not found at this bank");
  if (a.kind !== "personal") throw new SimError("Trust accounts cannot be used at the counter");
  if (a.status !== "active") throw new SimError("Source account is frozen");
  return a;
}

/**
 * Bank to wallet, through the national switch. Paid from an account, or in cash over the counter.
 * This is also how an agent buys float: the bank pushes money to the agent's wallet.
 */
export function bankToWallet(w: World, req: { bank: string; fromAccount?: string; msisdn: string; amount: number; reference?: string }): Receipt {
  const src = bankSource(w, req.bank, req.fromAccount);
  const to = walletByMsisdn(w, req.msisdn);
  if (!to) throw new SimError("That number is not registered for mobile money");
  const id = newId("tx");
  const base = { type: "bank_to_wallet", channel: "branch", from_account: src?.id ?? null, to_wallet: to.id, from_party: req.bank, to_party: to.telco, rail: "switch", amount: req.amount, reference: req.reference ?? null };
  const no = (why: string) => refuse(w, base, why, id);
  if (to.status === "frozen") no("Recipient wallet cannot receive payments");
  const fee = src ? feeFor(getConfig(w.db, `bank.${req.bank}`).fees.toWallet, req.amount) : 0;
  if (src && src.balance < req.amount + fee) no("Insufficient funds in the account");
  const limit = checkReceiveLimit(w, to, req.amount);
  if (limit) no(limit);
  try {
    route(w, id, req.bank, to.telco, req.amount, to.msisdn);
  } catch (e) {
    no((e as Error).message);
  }

  tx(w.db, () => {
    insertTxn(w, { ...base, id, fee, status: "success" });
    post(w, id, [
      src ? [`bank:${src.id}`, -(req.amount + fee)] : [`vault:${req.bank}`, -req.amount],
      [`fee:${req.bank}`, fee],
      ...positionEntries(req.bank, to.telco, req.amount),
      [`w:${to.id}`, req.amount],
    ]);
    commit(w, id, req.bank, to.telco, req.amount);
    notify(w, to.telco, "transfer_received", to.msisdn, { amount: cedis(req.amount), counterparty: bankName(req.bank), counterparty_name: src?.name ?? "Cash deposit", balance: cedis(getWallet(w, to.id)!.balance), reference: req.reference ?? "", txn_id: shortId(id) });
    audit(w, req.bank, "bank_to_wallet", `GHS ${cedis(req.amount)} ${src ? `from ${src.name}` : "in cash"} to ${to.display_name} (${to.msisdn})`);
  });
  return { txnId: id, fee, commission: 0, message: `GHS ${cedis(req.amount)} sent to ${to.display_name} on ${TELCO_INFO[to.telco].wallet}. Fee GHS ${cedis(fee)}.` };
}

/** Account to account. Within one bank it is a book transfer; between banks it goes through the switch. */
export function bankTransfer(w: World, req: { bank: string; fromAccount: string; toAccountNo: string; amount: number; reference?: string }): Receipt {
  const src = bankSource(w, req.bank, req.fromAccount)!;
  if (!src) throw new SimError("Choose the account to pay from");
  const dest = accountByNumber(w, req.toAccountNo);
  if (!dest || dest.kind !== "personal") throw new SimError("Destination account not found");
  if (dest.id === src.id) throw new SimError("Source and destination are the same account");
  const interbank = dest.bank !== req.bank;
  const id = newId("tx");
  const base = { type: "bank_transfer", channel: "branch", from_account: src.id, to_account: dest.id, from_party: req.bank, to_party: dest.bank, rail: interbank ? "switch" : "internal", amount: req.amount, reference: req.reference ?? null };
  const no = (why: string) => refuse(w, base, why, id);
  if (dest.status !== "active") no("Destination account is frozen");
  const fee = interbank ? feeFor(getConfig(w.db, `bank.${req.bank}`).fees.interbank, req.amount) : 0;
  if (src.balance < req.amount + fee) no("Insufficient funds in the account");
  if (interbank) {
    try {
      route(w, id, req.bank, dest.bank, req.amount, `account ${dest.account_no}`);
    } catch (e) {
      no((e as Error).message);
    }
  }
  tx(w.db, () => {
    insertTxn(w, { ...base, id, fee, status: "success" });
    post(w, id, [[`bank:${src.id}`, -(req.amount + fee)], [`fee:${req.bank}`, fee], ...(interbank ? positionEntries(req.bank, dest.bank, req.amount) : []), [`bank:${dest.id}`, req.amount]]);
    if (interbank) commit(w, id, req.bank, dest.bank, req.amount);
    audit(w, req.bank, "transfer", `GHS ${cedis(req.amount)} from ${src.name} to ${dest.name} (${bankName(dest.bank)})`);
  });
  return { txnId: id, fee, commission: 0, message: `GHS ${cedis(req.amount)} sent to ${dest.name} at ${bankName(dest.bank)}. Fee GHS ${cedis(fee)}.` };
}

/** Cash over the counter: a deposit into, or withdrawal from, an account. */
export function bankCash(w: World, req: { bank: string; account: string; amount: number; kind: "deposit" | "withdrawal" }): Receipt {
  const a = bankSource(w, req.bank, req.account)!;
  if (!a) throw new SimError("Choose an account");
  const id = newId("tx");
  const out = req.kind === "withdrawal";
  if (out && a.balance < req.amount) refuse(w, { type: "withdrawal", channel: "branch", from_account: a.id, from_party: req.bank, rail: "cash", amount: req.amount }, "Insufficient funds in the account", id);
  tx(w.db, () => {
    insertTxn(w, { id, type: req.kind, channel: "branch", [out ? "from_account" : "to_account"]: a.id, [out ? "from_party" : "to_party"]: req.bank, rail: "cash", amount: req.amount, status: "success" });
    post(w, id, out ? [[`bank:${a.id}`, -req.amount], [`vault:${req.bank}`, req.amount]] : [[`vault:${req.bank}`, -req.amount], [`bank:${a.id}`, req.amount]]);
    audit(w, req.bank, req.kind, `Cash ${req.kind} of GHS ${cedis(req.amount)} on ${a.name} (${a.account_no})`);
  });
  return { txnId: id, fee: 0, commission: 0, message: `Cash ${req.kind} of GHS ${cedis(req.amount)} done. New balance GHS ${cedis(getAccount(w, a.id)!.balance)}.` };
}

/** A telco reverses one of its own wallet payments: every posting of the original is undone. */
export function reverse(w: World, telco: Telco, txnId: string): Receipt {
  const t = getTxn(w, txnId);
  if (!t) throw new SimError("Transaction not found");
  if (t.from_party !== telco) throw new SimError("Only the sending network can reverse this transaction");
  if (t.status !== "success") throw new SimError(`Transaction is ${t.status}; it cannot be reversed`);
  if (count(w.db, "SELECT COUNT(*) AS n FROM tickets WHERE txn_id = ? AND (status NOT IN ('resolved','rejected') OR returned > 0 OR held > 0)", t.id)) throw new SimError("This payment has a dispute in customer care. Settle it there.");
  if (!["p2p", "merchant", "cashin", "cashout", "float"].includes(t.type)) throw new SimError("Only wallet-to-wallet payments can be reversed here. Bank transfers are disputed through the bank.");
  const original = w.db.prepare("SELECT account, amount FROM postings WHERE txn_id = ?").all(t.id) as { account: string; amount: number }[];
  for (const p of original) {
    if (p.amount > 0 && p.account.startsWith("w:") && getWallet(w, p.account.slice(2))!.balance < p.amount) throw new SimError(`${getWallet(w, p.account.slice(2))!.display_name} no longer has enough balance to return the money`);
  }
  const id = newId("tx");
  tx(w.db, () => {
    insertTxn(w, { id, type: "reversal", channel: "console", from_wallet: t.to_wallet, to_wallet: t.from_wallet, from_party: t.to_party, to_party: t.from_party, rail: t.rail, amount: t.amount, fee: -t.fee, commission: -t.commission, status: "success", related: t.id, reference: `Reversal of ${shortId(t.id)}` });
    post(w, id, original.map((p) => [p.account, -p.amount] as [string, number]));
    w.db.prepare("UPDATE txns SET status = 'reversed' WHERE id = ?").run(t.id);
    if (t.type === "cashin") w.db.prepare("UPDATE momo_agents SET cash = cash - ?, commission = commission - ? WHERE wallet_id = ?").run(t.amount, t.commission, t.from_wallet);
    if (t.type === "cashout") w.db.prepare("UPDATE momo_agents SET cash = cash + ?, commission = commission - ? WHERE wallet_id = ?").run(t.amount, t.commission, t.to_wallet);
    for (const wid of [t.from_wallet, t.to_wallet]) {
      const wal = wid ? getWallet(w, wid) : undefined;
      if (wal) notify(w, wal.telco, "reversal", wal.msisdn, { amount: cedis(t.amount), txn_id: shortId(t.id), balance: cedis(wal.balance) });
    }
    audit(w, telco, "reversal", `Reversed ${t.type} ${shortId(t.id)} of GHS ${cedis(t.amount)}`);
  });
  return { txnId: id, fee: 0, commission: 0, message: `Transaction ${shortId(t.id)} reversed.` };
}
