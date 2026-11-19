import { randomUUID } from "node:crypto";
import { getConfig } from "./config/store";
import { recipientAnswered } from "./care";
import { checkPin, getWallet, walletByMsisdn } from "./ledger";
import { notify } from "./notify";
import { walletPay, type Receipt } from "./payments";
import { MINUTE, SimError, cedis, toIntl } from "./util";
import type { World } from "./world";

/**
 * Payments that wait for the payer to say yes on their own phone: an agent's cash-out request,
 * or a merchant's Request to Pay (modelled on the MTN MoMo Collections API).
 */

export interface ApprovalRow {
  ref: string;
  kind: "cashout" | "rtp" | "dispute";
  telco: string;
  payee_wallet: string;
  payer_msisdn: string;
  amount: number;
  external_id: string | null;
  payer_message: string | null;
  payee_note: string | null;
  status: "PENDING" | "SUCCESSFUL" | "FAILED";
  reason: string | null;
  txn_id: string | null;
  callback_url: string | null;
  created_at: number;
}

export const getApproval = (w: World, ref: string) => w.db.prepare("SELECT * FROM approvals WHERE ref = ?").get(ref) as ApprovalRow | undefined;

export function createApproval(
  w: World,
  r: { ref?: string; kind: "cashout" | "rtp"; payeeWallet: string; payerMsisdn: string; amount: number; externalId?: string; payerMessage?: string; payeeNote?: string; callbackUrl?: string },
): ApprovalRow {
  const payee = getWallet(w, r.payeeWallet);
  if (!payee) throw new SimError("Payee wallet not found");
  const payer = walletByMsisdn(w, r.payerMsisdn);
  if (r.kind === "cashout") {
    if (!payer) throw new SimError("That number is not registered for mobile money");
    if (payer.telco !== payee.telco) throw new SimError("Cash-out is only for customers on the agent's own network");
    if (payer.id === payee.id) throw new SimError("An agent cannot cash out from its own agent line");
  }
  const ref = r.ref ?? randomUUID();
  w.db
    .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, payee_note, status, reason, callback_url, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(ref, r.kind, payee.telco, payee.id, r.payerMsisdn, r.amount, r.externalId ?? null, r.payerMessage ?? null, r.payeeNote ?? null, payer ? "PENDING" : "FAILED", payer ? null : "PAYER_NOT_FOUND", r.callbackUrl ?? null, w.now);
  if (payer) notify(w, payer.telco, "approval_prompt", payer.msisdn, { amount: cedis(r.amount), counterparty_name: payee.display_name, counterparty: payee.msisdn, reason: r.kind === "cashout" ? "cash-out" : r.payerMessage || "payment" });
  else void callback(w, ref);
  return getApproval(w, ref)!;
}

/** Requests nobody answered in time are closed. */
export function expireApprovals(w: World) {
  // A request to return disputed money stays open until the recipient answers or customer care withdraws it.
  const rows = w.db.prepare("SELECT ref, telco, created_at FROM approvals WHERE status = 'PENDING' AND kind != 'dispute'").all() as { ref: string; telco: string; created_at: number }[];
  for (const r of rows) {
    const minutes = getConfig(w.db, `telco.${r.telco}`).approvalMinutes;
    if (w.now - r.created_at > minutes * MINUTE) rejectApproval(w, r.ref, "EXPIRED");
  }
}

export function pendingFor(w: World, msisdn: string) {
  expireApprovals(w);
  return w.db
    .prepare("SELECT a.ref, a.kind, a.amount, a.payer_message, w.display_name FROM approvals a JOIN wallets w ON w.id = a.payee_wallet WHERE a.payer_msisdn = ? AND a.status = 'PENDING' ORDER BY a.created_at DESC LIMIT 5")
    .all(msisdn) as { ref: string; kind: "cashout" | "rtp" | "dispute"; amount: number; payer_message: string | null; display_name: string }[];
}

/** The payer approves with their PIN; the money moves. */
export function approve(w: World, ref: string, pin: string): Receipt {
  expireApprovals(w);
  const r = getApproval(w, ref);
  if (!r || r.status !== "PENDING") throw new SimError("This request is no longer pending.");
  const payer = walletByMsisdn(w, r.payer_msisdn)!;
  if (r.kind === "dispute") {
    // Agreeing to give back money received by mistake.
    checkPin(w, payer, pin, getConfig(w.db, `telco.${payer.telco}`).pinAttemptsBeforeLock);
    const message = recipientAnswered(w, r.external_id!, true);
    w.db.prepare("UPDATE approvals SET status = 'SUCCESSFUL' WHERE ref = ?").run(ref);
    return { txnId: "", fee: 0, commission: 0, message };
  }
  try {
    const res = walletPay(w, { type: r.kind === "cashout" ? "cashout" : "merchant", channel: "ussd", from: payer.id, to: r.payee_wallet, amount: r.amount, pin, reference: r.payer_message ?? undefined });
    w.db.prepare("UPDATE approvals SET status = 'SUCCESSFUL', txn_id = ? WHERE ref = ?").run(res.txnId, ref);
    void callback(w, ref);
    return res;
  } catch (e) {
    // A wrong PIN leaves the request open for another try; anything else closes it.
    if (!(e as Error).message.startsWith("Wrong PIN.")) rejectApproval(w, ref, (e as Error).message);
    throw e;
  }
}

export function rejectApproval(w: World, ref: string, reason: string) {
  const r = getApproval(w, ref);
  if (r?.kind === "dispute" && r.status === "PENDING") recipientAnswered(w, r.external_id!, false);
  w.db.prepare("UPDATE approvals SET status = 'FAILED', reason = ? WHERE ref = ? AND status = 'PENDING'").run(reason, ref);
  void callback(w, ref);
}

/** The shape the MTN MoMo Collections API returns for a Request to Pay. */
export function approvalView(r: ApprovalRow) {
  return {
    amount: cedis(r.amount),
    currency: "GHS",
    financialTransactionId: r.txn_id ?? undefined,
    externalId: r.external_id ?? undefined,
    payer: { partyIdType: "MSISDN", partyId: toIntl(r.payer_msisdn) },
    payerMessage: r.payer_message ?? undefined,
    payeeNote: r.payee_note ?? undefined,
    status: r.status,
    reason: r.reason ?? undefined,
  };
}

async function callback(w: World, ref: string) {
  const r = getApproval(w, ref);
  if (!r?.callback_url) return;
  try {
    await fetch(r.callback_url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ referenceId: ref, ...approvalView(r) }), signal: AbortSignal.timeout(3000) });
  } catch {
    // Callbacks are best effort, as with the real API.
  }
}
