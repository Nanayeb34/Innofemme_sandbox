import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError, authWorld, handle } from "@/server/http";
import { merchantFor } from "@/server/merchant";
import { issueToken, notifyPartner, partnerOf, partnerWorld } from "@/server/partner-auth";
import { teamById } from "@/engine/worlds";
import { approvalView, cancelPreapproval, createApproval, createConsent, createPreapproval, getApproval, getConsent, getPreapproval } from "@/engine/approvals";
import { walletByMsisdn, type WalletRow } from "@/engine/ledger";
import { personById } from "@/engine/nia";
import { clientWallet, createClient, getClient, rotateSecret, type ApiClient } from "@/engine/partners";
import { walletPay } from "@/engine/payments";
import { sendAppSms } from "@/engine/sms";
import { withLock, type World } from "@/engine/world";
import { SimError, TELCOS, cedis, normalizeMsisdn, toIntl, type Telco } from "@/engine/util";

/**
 * The mobile money partner API, in the shape of the MTN MoMo Open API (collection, disbursement and
 * remittance products). This is what a network gives a licensed payments company.
 * Base URL: /api/w/{team}/momo/{mtn|telecel|at}
 *
 * A partner authenticates with the API user and key the network issued (Basic at .../token/, then
 * Bearer). The team key also works, acting for the merchant named in X-Merchant-Id.
 * Telecel and AT use the same shape until their own specifications are received.
 */

type Ctx = RouteContext<"/api/w/[team]/momo/[telco]/[...path]">;
const teamTokens = ((globalThis as unknown as { __momoTokens?: Map<string, { team: string; exp: number }> }).__momoTokens ??= new Map());
/** Tokens that let a partner read one customer's profile, after that customer consented. */
const profileTokens = ((globalThis as unknown as { __momoProfileTokens?: Map<string, { team: string; msisdn: string; exp: number }> }).__momoProfileTokens ??= new Map());

const momoError = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });
const accepted = () => new Response(null, { status: 202 });

async function setup(ctx: Ctx) {
  const { team, telco, path } = await ctx.params;
  if (!(TELCOS as readonly string[]).includes(telco)) throw new HttpError(404, "Unknown telco. Use mtn, telecel or at.");
  return { team, telco: telco as Telco, path: path.join("/").replace(/\/$/, "") };
}

interface Caller {
  w: World;
  /** The merchant wallet payments are collected into and paid out from. */
  wallet: () => WalletRow;
  client?: ApiClient;
  /** The name customers see, and the partner's default callback address. */
  name: string;
  callback?: string | null;
}

/** Who is calling: a partner with its own credentials, or the team acting for one of the network's merchants. */
async function caller(req: Request, team: string, telco: Telco): Promise<Caller> {
  const partner = partnerOf(req, team, telco);
  if (partner) return { w: partner.w, client: partner.client, name: partner.client.name, callback: partner.client.callback_url, wallet: () => clientWallet(partner.w, partner.client) };
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const t = bearer ? teamTokens.get(bearer) : undefined;
  const w = t && t.team === team && t.exp > Date.now() ? await authWorld(new Request(req.url, { headers: { "x-team-key": teamById(team)?.key ?? "" } }), team) : await authWorld(req, team);
  return { w, name: "Team", wallet: () => merchantFor(w, req, telco) };
}

async function json(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function amountOf(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100);
}

const party = (v: unknown) => (v as { partyId?: string } | undefined)?.partyId;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function payoutView(r: Record<string, string | number | null>) {
  return {
    amount: cedis(r.amount as number),
    currency: "GHS",
    financialTransactionId: r.txn_id ?? undefined,
    externalId: r.external_id ?? undefined,
    payee: { partyIdType: "MSISDN", partyId: toIntl(String(r.payee_msisdn)) },
    payerMessage: r.payer_message ?? undefined,
    payeeNote: r.payee_note ?? undefined,
    status: r.status,
    reason: r.reason ?? undefined,
  };
}

const getPayout = (w: World, ref: string, telco: Telco) => w.db.prepare("SELECT * FROM api_transfers WHERE ref = ? AND telco = ?").get(ref, telco) as Record<string, string | number | null> | undefined;

/** Pays out from the partner's merchant wallet and records the result under the partner's reference. */
function payout(w: World, telco: Telco, from: WalletRow, ref: string, o: { msisdn: string; amount: number; externalId?: string; payerMessage?: string; payeeNote?: string; waiveFee?: boolean }) {
  const to = walletByMsisdn(w, o.msisdn);
  let txnId: string | null = null;
  let reason: string | null = to ? null : "PAYEE_NOT_FOUND";
  if (to) {
    try {
      txnId = walletPay(w, { type: "p2p", channel: "api", from: from.id, to: to.id, amount: o.amount, reference: o.payerMessage, waiveFee: o.waiveFee }).txnId;
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      reason = e.message;
    }
  }
  w.db
    .prepare("INSERT INTO api_transfers(ref, telco, payee_msisdn, amount, external_id, payer_message, payee_note, status, reason, txn_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(ref, telco, o.msisdn, o.amount, o.externalId ?? null, o.payerMessage ?? null, o.payeeNote ?? null, txnId ? "SUCCESSFUL" : "FAILED", reason, txnId, w.now);
  return getPayout(w, ref, telco)!;
}

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  let m: RegExpMatchArray | null;

  // ----- credentials -----
  if (/^(collection|disbursement|remittance)\/token$/.test(path)) {
    const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    const [user, key] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
    // The team itself may still ask for a token with its team id and key.
    if (user === team && key === teamById(team)?.key) {
      const token = randomBytes(24).toString("base64url");
      teamTokens.set(token, { team, exp: Date.now() + 3600_000 });
      return { access_token: token, token_type: "access_token", expires_in: 3600 };
    }
    try {
      return issueToken(req, team, telco);
    } catch {
      return momoError(401, "UNAUTHORIZED", "Use Basic auth with the API user and API key the network issued");
    }
  }

  // Sandbox provisioning, as on MTN's developer portal: create an API user, then ask for its key.
  if (path === "v1_0/apiuser") {
    const w = await authWorld(req, team);
    const id = req.headers.get("x-reference-id") ?? randomUUID();
    const b = await json(req).catch(() => ({}) as Record<string, unknown>);
    const host = str(b.providerCallbackHost);
    await withLock(w, () => createClient(w, telco, { id, name: str(b.name) ?? `API user ${id.slice(0, 8)}`, till: req.headers.get("x-merchant-id") ?? undefined, callbackUrl: host ? (/^https?:\/\//.test(host) ? host : `https://${host}`) : undefined }));
    return new Response(null, { status: 201 });
  }
  if ((m = path.match(/^v1_0\/apiuser\/([\w-]+)\/apikey$/))) {
    const w = await authWorld(req, team);
    const id = m[1];
    if (getClient(w, id)?.institution !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "API user not found");
    return NextResponse.json({ apiKey: await withLock(w, () => rotateSecret(w, telco, id)) }, { status: 201 });
  }

  const who = await caller(req, team, telco);
  const w = who.w;
  const ref = req.headers.get("x-reference-id") ?? randomUUID();
  const callbackUrl = req.headers.get("x-callback-url") ?? who.callback ?? undefined;

  // ----- collection: money in from customers -----
  if ((m = path.match(/^collection\/v[12]_0\/(requesttopay|requesttowithdraw)$/))) {
    const b = await json(req);
    const payer = party(b.payer);
    const amount = amountOf(b.amount);
    if (!amount || !payer) return momoError(400, "INVALID_INPUT", "amount and payer.partyId are required");
    if (b.currency && b.currency !== "GHS") return momoError(400, "INVALID_CURRENCY", "Currency must be GHS");
    if (getApproval(w, ref)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    await withLock(w, () =>
      createApproval(w, { ref, kind: "rtp", payeeWallet: who.wallet().id, payerMsisdn: normalizeMsisdn(payer), amount, externalId: str(b.externalId), payerMessage: str(b.payerMessage) ?? (m![1] === "requesttowithdraw" ? "Withdrawal" : undefined), payeeNote: str(b.payeeNote), callbackUrl }),
    );
    return accepted();
  }

  if ((m = path.match(/^collection\/v1_0\/requesttopay\/([\w-]+)\/deliverynotification$/))) {
    const b = await json(req);
    const r = getApproval(w, m[1]);
    const text = str(b.notificationMessage) ?? req.headers.get("notificationmessage") ?? "";
    if (!r || r.telco !== telco || r.kind !== "rtp" || r.payee_wallet !== who.wallet().id) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    if (r.status !== "SUCCESSFUL") return momoError(409, "NOT_ALLOWED", "A delivery notification can only follow a successful payment");
    if (!text || text.length > 160) return momoError(400, "INVALID_INPUT", "notificationMessage is required, at most 160 characters");
    await withLock(w, () => sendAppSms(w, { display_name: who.wallet().display_name, telco }, { to: r.payer_msisdn, text }));
    return new Response(null, { status: 200 });
  }

  if (/^collection\/v[12]_0\/preapproval$/.test(path)) {
    const b = await json(req);
    const payer = party(b.payer);
    if (!payer) return momoError(400, "INVALID_INPUT", "payer.partyId is required");
    if (getPreapproval(w, ref)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    await withLock(w, () => createPreapproval(w, { ref, payeeWallet: who.wallet().id, payerMsisdn: normalizeMsisdn(payer), message: str(b.payerMessage), validitySeconds: Number(b.validityTime) || undefined }));
    return accepted();
  }

  // Consent to read a customer's profile: ask (bc-authorize), then swap the request id for a token once they agree.
  if (path === "collection/v1_0/bc-authorize") {
    if (!who.client) return momoError(403, "NOT_ALLOWED", "Profile consent needs a partner's own API credentials");
    const form = new URLSearchParams(await req.text());
    const hint = (form.get("login_hint") ?? "").replace(/^(ID|MSISDN):/i, "").replace(/\/MSISDN$/i, "");
    if (!hint) return momoError(400, "INVALID_INPUT", "login_hint is required, e.g. ID:233241234567/MSISDN");
    try {
      const c = await withLock(w, () => createConsent(w, { clientId: who.client!.id, partnerName: who.name, msisdn: normalizeMsisdn(hint), scope: form.get("scope") ?? "profile" }));
      return { auth_req_id: c.ref, interval: 5, expires_in: 600 };
    } catch (e) {
      if (e instanceof SimError) return momoError(404, "RESOURCE_NOT_FOUND", e.message);
      throw e;
    }
  }
  if (path === "collection/oauth2/token") {
    if (!who.client) return momoError(403, "NOT_ALLOWED", "Profile consent needs a partner's own API credentials");
    const form = new URLSearchParams(await req.text());
    const c = getConsent(w, form.get("auth_req_id") ?? "");
    if (!c || c.client_id !== who.client.id) return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
    if (c.status === "PENDING" && c.expires_at > Date.now()) return NextResponse.json({ error: "authorization_pending" }, { status: 400 });
    if (c.status !== "APPROVED") return NextResponse.json({ error: c.status === "REJECTED" ? "access_denied" : "expired_token" }, { status: 400 });
    const token = randomBytes(24).toString("base64url");
    profileTokens.set(token, { team, msisdn: c.msisdn, exp: Date.now() + 3600_000 });
    return { access_token: token, token_type: "Bearer", expires_in: 3600, scope: c.scope };
  }

  // ----- disbursement and remittance: money out to customers -----
  if ((m = path.match(/^(disbursement|remittance)\/v[12]_0\/(transfer|deposit)$/))) {
    const b = await json(req);
    const payee = party(b.payee);
    const amount = amountOf(b.amount);
    if (!amount || !payee) return momoError(400, "INVALID_INPUT", "amount and payee.partyId are required");
    if (getPayout(w, ref, telco)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    const r = await withLock(w, () => payout(w, telco, who.wallet(), ref, { msisdn: normalizeMsisdn(payee), amount, externalId: str(b.externalId), payerMessage: str(b.payerMessage), payeeNote: str(b.payeeNote) }));
    void notifyPartner(callbackUrl, { referenceId: ref, ...payoutView(r) });
    return accepted();
  }

  // Gives a customer back all or part of a payment this partner collected from them.
  if (/^disbursement\/v[12]_0\/refund$/.test(path)) {
    const b = await json(req);
    const amount = amountOf(b.amount);
    const original = getApproval(w, str(b.referenceIdToRefund) ?? "");
    if (!amount || !original) return momoError(400, "INVALID_INPUT", "amount and referenceIdToRefund (a payment you collected) are required");
    if (original.kind !== "rtp" || original.telco !== telco || original.payee_wallet !== who.wallet().id) return momoError(404, "RESOURCE_NOT_FOUND", "That payment was not collected by this partner");
    if (original.status !== "SUCCESSFUL") return momoError(409, "NOT_ALLOWED", "Only a successful payment can be refunded");
    if (getPayout(w, ref, telco)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    const refunded = Number((w.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM api_transfers WHERE external_id = ? AND status = 'SUCCESSFUL'").get(`refund:${original.ref}`) as { n: number }).n);
    if (refunded + amount > original.amount) return momoError(409, "NOT_ALLOWED", "The refund is more than what is left of the original payment");
    const r = await withLock(w, () => payout(w, telco, who.wallet(), ref, { msisdn: original.payer_msisdn, amount, externalId: `refund:${original.ref}`, payerMessage: str(b.payerMessage) ?? "Refund", payeeNote: str(b.payeeNote), waiveFee: true }));
    void notifyPartner(callbackUrl, { referenceId: ref, ...payoutView(r) });
    return accepted();
  }

  return momoError(404, "NOT_FOUND", `No such endpoint: POST ${path}`);
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  let m: RegExpMatchArray | null;

  // A customer's full profile, with the token issued after they consented.
  if (path === "collection/oauth2/v1_0/userinfo") {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const t = bearer ? profileTokens.get(bearer) : undefined;
    if (!t || t.team !== team || t.exp < Date.now()) return momoError(401, "UNAUTHORIZED", "Use the token from collection/oauth2/token, issued after the customer consented");
    const w = partnerWorld(team);
    const wallet = walletByMsisdn(w, t.msisdn);
    const p = wallet ? personById(w, wallet.person_id) : undefined;
    if (!wallet || !p) return momoError(404, "RESOURCE_NOT_FOUND", "Account holder not found");
    const sim = w.db.prepare("SELECT registered_at FROM sims WHERE msisdn = ?").get(wallet.msisdn) as { registered_at: number | null } | undefined;
    return {
      sub: toIntl(wallet.msisdn), name: `${p.first_names} ${p.surname}`, given_name: p.first_names, family_name: p.surname, birthdate: p.dob, gender: p.gender === "F" ? "FEMALE" : "MALE",
      locale: "en", phone_number: toIntl(wallet.msisdn), phone_number_verified: true, address: { locality: p.town, region: p.region, country: "GH" }, status: wallet.status.toUpperCase(),
      kyc_tier: wallet.kyc_tier, identification_type: "GHANA_CARD", registered_since: sim?.registered_at ? new Date(sim.registered_at).toISOString() : undefined, updated_at: Math.floor(Date.now() / 1000),
    };
  }

  if ((m = path.match(/^v1_0\/apiuser\/([\w-]+)$/))) {
    const w = await authWorld(req, team);
    const c = getClient(w, m[1]);
    if (!c || c.institution !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "API user not found");
    return { providerCallbackHost: c.callback_url ?? "", targetEnvironment: "sandbox" };
  }

  const who = await caller(req, team, telco);
  const w = who.w;

  if ((m = path.match(/^collection\/v[12]_0\/(?:requesttopay|requesttowithdraw)\/([\w-]+)$/))) {
    const r = getApproval(w, m[1]);
    if (!r || r.telco !== telco || r.kind !== "rtp") return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return approvalView(r);
  }
  if ((m = path.match(/^collection\/v[12]_0\/preapproval\/([\w-]+)$/))) {
    const p = getPreapproval(w, m[1]);
    if (!p || p.telco !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return { payer: { partyIdType: "MSISDN", partyId: toIntl(p.payer_msisdn) }, payerCurrency: "GHS", payerMessage: p.message ?? undefined, status: p.status === "SUCCESSFUL" && p.expires_at < Date.now() ? "EXPIRED" : p.status, expirationDateTime: new Date(p.expires_at).toISOString(), reason: p.reason ?? undefined };
  }
  if ((m = path.match(/^(?:disbursement|remittance)\/v[12]_0\/(?:transfer|deposit|refund)\/([\w-]+)$/))) {
    const r = getPayout(w, m[1], telco);
    if (!r) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return payoutView(r);
  }
  if (/^(collection|disbursement|remittance)\/v1_0\/account\/balance(\/GHS)?$/.test(path)) {
    return { availableBalance: cedis(who.wallet().balance), currency: "GHS" };
  }
  if ((m = path.match(/^(?:collection|disbursement|remittance)\/v1_0\/accountholder\/msisdn\/(\d+)\/(active|basicuserinfo)$/))) {
    const wallet = walletByMsisdn(w, normalizeMsisdn(m[1]));
    if (m[2] === "active") return { result: !!wallet && wallet.status === "active" && wallet.telco === telco };
    if (!wallet || wallet.telco !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "Account holder not found");
    const [given, ...rest] = wallet.display_name.split(" ");
    return { given_name: given, family_name: rest.join(" "), name: wallet.display_name, locale: "en", status: wallet.status.toUpperCase() };
  }
  return momoError(404, "NOT_FOUND", `No such endpoint: GET ${path}`);
});

/** Withdraws a standing permission to charge a customer. */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  const m = path.match(/^collection\/v[12]_0\/preapproval\/([\w-]+)$/);
  if (!m) return momoError(404, "NOT_FOUND", `No such endpoint: DELETE ${path}`);
  const who = await caller(req, team, telco);
  await withLock(who.w, () => cancelPreapproval(who.w, m[1], who.wallet().id));
  return new Response(null, { status: 200 });
});
