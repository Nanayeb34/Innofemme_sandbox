import { randomUUID } from "node:crypto";
import { cedis, notify } from "./notify";
import { getWallet, transfer, walletByMsisdn, type Actor, type TransferResult } from "./payments";
import type { World } from "./world";

/** Request to Pay, modelled on the MTN MoMo Collections API. */

export interface RtpRow {
  ref: string;
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
  scenario: string | null;
  is_fraud: number;
}

export const RTP_EXPIRY_MS = 5 * 60_000;

export function createRtp(
  w: World,
  r: { ref?: string; payeeWallet: string; payerMsisdn: string; amount: number; externalId?: string; payerMessage?: string; payeeNote?: string; callbackUrl?: string; scenario?: string; isFraud?: boolean },
): { ref: string } | { error: string } {
  const payee = getWallet(w, r.payeeWallet);
  if (!payee) return { error: "PAYEE_NOT_FOUND" };
  const payer = walletByMsisdn(w, r.payerMsisdn);
  const ref = r.ref ?? randomUUID();
  w.db
    .prepare(
      "INSERT INTO rtp(ref, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, payee_note, status, reason, callback_url, created_at, scenario, is_fraud) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      ref, payee.telco, payee.id, r.payerMsisdn, r.amount, r.externalId ?? null, r.payerMessage ?? null, r.payeeNote ?? null,
      payer ? "PENDING" : "FAILED", payer ? null : "PAYER_NOT_FOUND", r.callbackUrl ?? null, w.now, r.scenario ?? null, r.isFraud ? 1 : 0,
    );
  if (payer) notify(w, "rtp_prompt", payer.msisdn, { amount: cedis(r.amount), counterparty_name: payee.display_name, counterparty: payee.msisdn, reference: r.payerMessage });
  else void callback(w, ref);
  return { ref };
}

export const getRtp = (w: World, ref: string) => w.db.prepare("SELECT * FROM rtp WHERE ref = ?").get(ref) as RtpRow | undefined;

export async function approveRtp(
  w: World,
  ref: string,
  opts: { initiatedBy: "human" | "bot"; actor?: Actor; acknowledgedWarning?: boolean; otp?: string },
): Promise<TransferResult> {
  const r = getRtp(w, ref);
  if (!r || r.status !== "PENDING") return { status: "failed", message: "This request is no longer pending.", fee: 0 };
  const payer = walletByMsisdn(w, r.payer_msisdn)!;
  const res = await transfer(w, {
    type: "rtp",
    channel: opts.initiatedBy === "human" ? "ussd" : "app",
    initiatedBy: opts.initiatedBy,
    from: payer.id,
    to: r.payee_wallet,
    amount: r.amount,
    reference: r.payer_message ?? undefined,
    actor: opts.actor,
    scenario: r.scenario ?? undefined,
    isFraud: !!r.is_fraud,
    acknowledgedWarning: opts.acknowledgedWarning,
    otp: opts.otp,
  });
  if (res.status === "needs_warning_ack" || res.status === "needs_otp") return res;
  const ok = res.status === "success" || res.status === "held";
  w.db.prepare("UPDATE rtp SET status = ?, reason = ?, txn_id = ? WHERE ref = ?").run(ok ? "SUCCESSFUL" : "FAILED", ok ? null : res.message, res.txnId ?? null, ref);
  void callback(w, ref);
  return res;
}

export function rejectRtp(w: World, ref: string, reason: string) {
  w.db.prepare("UPDATE rtp SET status = 'FAILED', reason = ? WHERE ref = ? AND status = 'PENDING'").run(reason, ref);
  void callback(w, ref);
}

export function expireRtps(w: World) {
  const rows = w.db.prepare("SELECT ref FROM rtp WHERE status = 'PENDING' AND created_at < ?").all(w.now - RTP_EXPIRY_MS) as { ref: string }[];
  for (const r of rows) rejectRtp(w, r.ref, "EXPIRED");
}

export function rtpView(r: RtpRow) {
  return {
    amount: cedis(r.amount),
    currency: "GHS",
    financialTransactionId: r.txn_id ?? undefined,
    externalId: r.external_id ?? undefined,
    payer: { partyIdType: "MSISDN", partyId: "233" + r.payer_msisdn.slice(1) },
    payerMessage: r.payer_message ?? undefined,
    payeeNote: r.payee_note ?? undefined,
    status: r.status,
    reason: r.reason ?? undefined,
  };
}

async function callback(w: World, ref: string) {
  const r = getRtp(w, ref);
  if (!r?.callback_url) return;
  try {
    await fetch(r.callback_url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ referenceId: ref, ...rtpView(r) }), signal: AbortSignal.timeout(3000) });
  } catch {
    // Callbacks are best effort, as with the real API.
  }
}
