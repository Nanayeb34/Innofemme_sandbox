import { Ask, Confirm, consult } from "./integrations";
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
  kind: "cashout" | "rtp" | "dispute" | "preapproval" | "consent";
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
  // The customer's network may have plugged in an API that screens requests before they reach the customer.
  let blocked: string | undefined;
  if (payer) {
    const standing = r.kind === "rtp" && hasPreapproval(w, payee.id, payer.msisdn);
    const d = consult(w, payer.telco, "payment.request", {
      kind: r.kind === "cashout" ? "cash_out" : "payment_request",
      amount: r.amount / 100,
      message: r.payerMessage ?? null,
      requester: { msisdn: payee.msisdn, name: payee.display_name, network: payee.telco, walletType: payee.owner_type, kycTier: payee.kyc_tier, walletOpenedAt: new Date(payee.created_at).toISOString() },
      customer: { msisdn: payer.msisdn, name: payer.display_name, network: payer.telco, walletType: payer.owner_type, kycTier: payer.kyc_tier, walletOpenedAt: new Date(payer.created_at).toISOString() },
      customerHasPaidThisRequesterBefore: !!w.db.prepare("SELECT 1 FROM txns WHERE from_wallet = ? AND to_wallet = ? AND status = 'success' LIMIT 1").get(payer.id, payee.id),
      requestsFromThisRequesterToday: Number((w.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE payee_wallet = ? AND created_at >= ?").get(payee.id, w.now - (w.now % 86_400_000)) as { n: number }).n),
      chargedWithoutAsking: standing,
    });
    if (d.decision === "reject") {
      blocked = d.message ?? "This request was blocked by the customer's network.";
      // At an agent's counter the agent is told straight away.
      if (r.kind === "cashout") throw new SimError(blocked);
    }
  }
  if (blocked) {
    w.db
      .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, payee_note, status, reason, callback_url, created_at) VALUES(?,?,?,?,?,?,?,?,?,'FAILED',?,?,?)")
      .run(ref, r.kind, payee.telco, payee.id, r.payerMsisdn, r.amount, r.externalId ?? null, r.payerMessage ?? null, r.payeeNote ?? null, blocked, r.callbackUrl ?? null, w.now);
    void callback(w, ref);
    return getApproval(w, ref)!;
  }
  w.db
    .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, payee_note, status, reason, callback_url, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(ref, r.kind, payee.telco, payee.id, r.payerMsisdn, r.amount, r.externalId ?? null, r.payerMessage ?? null, r.payeeNote ?? null, payer ? "PENDING" : "FAILED", payer ? null : "PAYER_NOT_FOUND", r.callbackUrl ?? null, w.now);
  if (!payer) {
    void callback(w, ref);
    return getApproval(w, ref)!;
  }
  // A customer who gave this business a standing permission is charged without being asked again.
  if (r.kind === "rtp" && hasPreapproval(w, payee.id, payer.msisdn)) {
    try {
      const res = walletPay(w, { type: "merchant", channel: "api", from: payer.id, to: payee.id, amount: r.amount, reference: r.payerMessage });
      w.db.prepare("UPDATE approvals SET status = 'SUCCESSFUL', txn_id = ? WHERE ref = ?").run(res.txnId, ref);
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      w.db.prepare("UPDATE approvals SET status = 'FAILED', reason = ? WHERE ref = ?").run(e.message, ref);
    }
    void callback(w, ref);
    return getApproval(w, ref)!;
  }
  notify(w, payer.telco, "approval_prompt", payer.msisdn, { amount: cedis(r.amount), counterparty_name: payee.display_name, counterparty: payee.msisdn, reason: r.kind === "cashout" ? "cash-out" : r.payerMessage || "payment" });
  return getApproval(w, ref)!;
}

/** Requests nobody answered in time are closed. */
export function expireApprovals(w: World) {
  // A request to return disputed money stays open until the recipient answers or customer care withdraws it.
  const rows = w.db.prepare("SELECT ref, telco, created_at FROM approvals WHERE status = 'PENDING' AND kind IN ('cashout','rtp')").all() as { ref: string; telco: string; created_at: number }[];
  for (const r of rows) {
    const minutes = getConfig(w.db, `telco.${r.telco}`).approvalMinutes;
    if (w.now - r.created_at > minutes * MINUTE) rejectApproval(w, r.ref, "EXPIRED");
  }
}

export function pendingFor(w: World, msisdn: string) {
  expireApprovals(w);
  return w.db
    .prepare("SELECT a.ref, a.kind, a.amount, a.payer_message, w.display_name FROM approvals a JOIN wallets w ON w.id = a.payee_wallet WHERE a.payer_msisdn = ? AND a.status = 'PENDING' ORDER BY a.created_at DESC LIMIT 5")
    .all(msisdn) as { ref: string; kind: ApprovalRow["kind"]; amount: number; payer_message: string | null; display_name: string }[];
}

/** The payer approves with their PIN; the money moves. */
export function approve(w: World, ref: string, pin: string, acknowledged = false): Receipt {
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
  if (r.kind === "preapproval" || r.kind === "consent") {
    checkPin(w, payer, pin, getConfig(w.db, `telco.${payer.telco}`).pinAttemptsBeforeLock);
    w.db.prepare("UPDATE approvals SET status = 'SUCCESSFUL' WHERE ref = ?").run(ref);
    if (r.kind === "preapproval") w.db.prepare("UPDATE preapprovals SET status = 'SUCCESSFUL' WHERE ref = ? AND status = 'PENDING'").run(r.external_id);
    else w.db.prepare("UPDATE consents SET status = 'APPROVED' WHERE ref = ? AND status = 'PENDING'").run(r.external_id);
    return { txnId: "", fee: 0, commission: 0, message: r.kind === "preapproval" ? `${r.payer_message} can now take payments from your wallet without asking each time.` : `Your details have been shared with ${r.payer_message}.` };
  }
  try {
    const res = walletPay(w, { type: r.kind === "cashout" ? "cashout" : "merchant", channel: "ussd", from: payer.id, to: r.payee_wallet, amount: r.amount, pin, reference: r.payer_message ?? undefined, acknowledged });
    w.db.prepare("UPDATE approvals SET status = 'SUCCESSFUL', txn_id = ? WHERE ref = ?").run(res.txnId, ref);
    void callback(w, ref);
    return res;
  } catch (e) {
    // Waiting on an outside API, or on the customer's answer to a warning: the request stays open.
    if (e instanceof Ask || e instanceof Confirm) throw e;
    // A wrong PIN leaves the request open for another try; anything else closes it.
    if (!(e as Error).message.startsWith("Wrong PIN.")) rejectApproval(w, ref, (e as Error).message);
    throw e;
  }
}

export function rejectApproval(w: World, ref: string, reason: string) {
  const r = getApproval(w, ref);
  if (r?.kind === "dispute" && r.status === "PENDING") recipientAnswered(w, r.external_id!, false);
  if (r?.kind === "preapproval" && r.status === "PENDING") w.db.prepare("UPDATE preapprovals SET status = 'FAILED', reason = ? WHERE ref = ? AND status = 'PENDING'").run(reason, r.external_id);
  if (r?.kind === "consent" && r.status === "PENDING") w.db.prepare("UPDATE consents SET status = 'REJECTED' WHERE ref = ? AND status = 'PENDING'").run(r.external_id);
  w.db.prepare("UPDATE approvals SET status = 'FAILED', reason = ? WHERE ref = ? AND status = 'PENDING'").run(reason, ref);
  void callback(w, ref);
}

// ---------- standing permissions (MoMo "pre-approval") ----------

export interface PreapprovalRow {
  ref: string;
  telco: string;
  payee_wallet: string;
  payer_msisdn: string;
  message: string | null;
  status: "PENDING" | "SUCCESSFUL" | "FAILED";
  reason: string | null;
  expires_at: number;
  created_at: number;
}

export const getPreapproval = (w: World, ref: string) => w.db.prepare("SELECT * FROM preapprovals WHERE ref = ?").get(ref) as PreapprovalRow | undefined;

const hasPreapproval = (w: World, payeeWallet: string, payerMsisdn: string) =>
  !!w.db.prepare("SELECT 1 FROM preapprovals WHERE payee_wallet = ? AND payer_msisdn = ? AND status = 'SUCCESSFUL' AND expires_at > ?").get(payeeWallet, payerMsisdn, w.now);

/**
 * A business asks a customer for permission to take payments without asking each time (for a
 * subscription, say). The customer grants or refuses it on their own phone, with their PIN.
 */
export function createPreapproval(w: World, r: { ref: string; payeeWallet: string; payerMsisdn: string; message?: string; validitySeconds?: number }): PreapprovalRow {
  const payee = getWallet(w, r.payeeWallet);
  if (!payee) throw new SimError("Payee wallet not found");
  const payer = walletByMsisdn(w, r.payerMsisdn);
  const seconds = Math.min(Math.max(Number(r.validitySeconds) || 30 * 86400, 60), 365 * 86400);
  w.db
    .prepare("INSERT INTO preapprovals(ref, telco, payee_wallet, payer_msisdn, message, status, reason, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(r.ref, payee.telco, payee.id, r.payerMsisdn, r.message ?? null, payer ? "PENDING" : "FAILED", payer ? null : "PAYER_NOT_FOUND", w.now + seconds * 1000, w.now);
  if (payer) {
    w.db
      .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, status, created_at) VALUES(?, 'preapproval', ?, ?, ?, 0, ?, ?, 'PENDING', ?)")
      .run(randomUUID(), payer.telco, payee.id, payer.msisdn, r.ref, payee.display_name, w.now);
    notify(w, payer.telco, "approval_prompt", payer.msisdn, { amount: "0.00", counterparty_name: payee.display_name, counterparty: payee.msisdn, reason: "permission to take payments without asking each time" });
  }
  return getPreapproval(w, r.ref)!;
}

export function cancelPreapproval(w: World, ref: string, payeeWallet: string) {
  const p = getPreapproval(w, ref);
  if (!p || p.payee_wallet !== payeeWallet) throw new SimError("Pre-approval not found", 404);
  w.db.prepare("UPDATE preapprovals SET status = 'FAILED', reason = 'CANCELLED' WHERE ref = ?").run(ref);
  w.db.prepare("UPDATE approvals SET status = 'FAILED', reason = 'CANCELLED' WHERE kind = 'preapproval' AND external_id = ? AND status = 'PENDING'").run(ref);
}

// ---------- consent to share a profile ----------

export interface ConsentRow {
  ref: string;
  telco: string;
  client_id: string;
  msisdn: string;
  scope: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  expires_at: number;
  created_at: number;
}

export const getConsent = (w: World, ref: string) => w.db.prepare("SELECT * FROM consents WHERE ref = ?").get(ref) as ConsentRow | undefined;

/** A partner asks a customer to share their profile. The customer agrees or refuses on their own phone, with their PIN. */
export function createConsent(w: World, r: { clientId: string; partnerName: string; msisdn: string; scope: string }): ConsentRow {
  const holder = walletByMsisdn(w, r.msisdn);
  if (!holder) throw new SimError("That number is not registered for mobile money", 404);
  const ref = randomUUID();
  w.db.prepare("INSERT INTO consents(ref, telco, client_id, msisdn, scope, status, expires_at, created_at) VALUES(?,?,?,?,?, 'PENDING', ?, ?)").run(ref, holder.telco, r.clientId, holder.msisdn, r.scope, w.now + 10 * MINUTE, w.now);
  // The approvals list needs a wallet to name; the customer's own stands in, and the partner's name is carried in the message.
  w.db
    .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, status, created_at) VALUES(?, 'consent', ?, ?, ?, 0, ?, ?, 'PENDING', ?)")
    .run(randomUUID(), holder.telco, holder.id, holder.msisdn, ref, r.partnerName, w.now);
  notify(w, holder.telco, "approval_prompt", holder.msisdn, { amount: "0.00", counterparty_name: r.partnerName, counterparty: "", reason: "to see your name, date of birth and registration details" });
  return getConsent(w, ref)!;
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
