import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError, authWorld, handle } from "@/server/http";
import { merchantFor } from "@/server/merchant";
import { teamById } from "@/engine/worlds";
import { approvalView, createApproval, getApproval } from "@/engine/approvals";
import { walletByMsisdn } from "@/engine/ledger";
import { walletPay } from "@/engine/payments";
import { withLock, type World } from "@/engine/world";
import { SimError, TELCOS, cedis, normalizeMsisdn, toIntl, type Telco } from "@/engine/util";

/**
 * Telco-style Open API modelled on MTN MoMo (collection + disbursement products).
 * Base URL: /api/w/{team}/momo/{mtn|telecel|at}
 * The caller acts as a merchant the telco has onboarded: send its merchant ID in the X-Merchant-Id header.
 * Telecel and AT use the same shape until their own specifications are received.
 */

const tokens = ((globalThis as unknown as { __momoTokens?: Map<string, { team: string; exp: number }> }).__momoTokens ??= new Map());

type Ctx = RouteContext<"/api/w/[team]/momo/[telco]/[...path]">;

async function setup(ctx: Ctx) {
  const { team, telco, path } = await ctx.params;
  if (!(TELCOS as readonly string[]).includes(telco)) throw new HttpError(404, "Unknown telco. Use mtn, telecel or at.");
  return { team, telco: telco as Telco, path: path.join("/") };
}

/** Accepts the access token from /token/, or the team key directly. */
async function authed(req: Request, team: string): Promise<World> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const t = bearer ? tokens.get(bearer) : undefined;
  if (t && t.team === team && t.exp > Date.now()) {
    const key = teamById(team)?.key;
    return authWorld(new Request(req.url, { headers: { "x-team-key": key ?? "" } }), team);
  }
  return authWorld(req, team);
}

const momoError = (status: number, code: string, message: string) => NextResponse.json({ code, message }, { status });

const merchant = merchantFor;

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

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);

  if (/^(collection|disbursement)\/token\/?$/.test(path)) {
    const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    const [user, key] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
    if (user !== team || key !== teamById(team)?.key) return momoError(401, "UNAUTHORIZED", "Use Basic auth with your team id as API user and your team key as API key");
    const token = randomBytes(24).toString("base64url");
    tokens.set(token, { team, exp: Date.now() + 3600_000 });
    return { access_token: token, token_type: "access_token", expires_in: 3600 };
  }

  const w = await authed(req, team);
  const ref = req.headers.get("x-reference-id") ?? randomUUID();
  const callbackUrl = req.headers.get("x-callback-url") ?? undefined;

  if (path === "collection/v1_0/requesttopay") {
    const b = await json(req);
    const payer = b.payer as { partyId?: string } | undefined;
    const amount = amountOf(b.amount);
    if (!amount || !payer?.partyId) return momoError(400, "INVALID_INPUT", "amount and payer.partyId are required");
    if (b.currency && b.currency !== "GHS") return momoError(400, "INVALID_CURRENCY", "Currency must be GHS");
    if (getApproval(w, ref)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    await withLock(w, () =>
      createApproval(w, { ref, kind: "rtp", payeeWallet: merchant(w, req, telco).id, payerMsisdn: normalizeMsisdn(payer.partyId!), amount, externalId: b.externalId as string, payerMessage: b.payerMessage as string, payeeNote: b.payeeNote as string, callbackUrl }),
    );
    return new Response(null, { status: 202 });
  }

  if (path === "disbursement/v1_0/transfer") {
    const b = await json(req);
    const payee = b.payee as { partyId?: string } | undefined;
    const amount = amountOf(b.amount);
    if (!amount || !payee?.partyId) return momoError(400, "INVALID_INPUT", "amount and payee.partyId are required");
    if (w.db.prepare("SELECT 1 FROM api_transfers WHERE ref = ?").get(ref)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    const msisdn = normalizeMsisdn(payee.partyId);
    await withLock(w, () => {
      const from = merchant(w, req, telco);
      const to = walletByMsisdn(w, msisdn);
      let txnId: string | null = null;
      let reason: string | null = to ? null : "PAYEE_NOT_FOUND";
      if (to) {
        try {
          txnId = walletPay(w, { type: "p2p", channel: "api", from: from.id, to: to.id, amount, reference: (b.payerMessage as string) ?? undefined }).txnId;
        } catch (e) {
          if (!(e instanceof SimError)) throw e;
          reason = e.message;
        }
      }
      w.db
        .prepare("INSERT INTO api_transfers(ref, telco, payee_msisdn, amount, external_id, payer_message, payee_note, status, reason, txn_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(ref, telco, msisdn, amount, (b.externalId as string) ?? null, (b.payerMessage as string) ?? null, (b.payeeNote as string) ?? null, txnId ? "SUCCESSFUL" : "FAILED", reason, txnId, w.now);
    });
    return new Response(null, { status: 202 });
  }

  return momoError(404, "NOT_FOUND", `No such endpoint: POST ${path}`);
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  const w = await authed(req, team);
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^collection\/v1_0\/requesttopay\/([\w-]+)$/))) {
    const r = getApproval(w, m[1]);
    if (!r || r.telco !== telco || r.kind !== "rtp") return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return approvalView(r);
  }
  if ((m = path.match(/^disbursement\/v1_0\/transfer\/([\w-]+)$/))) {
    const r = w.db.prepare("SELECT * FROM api_transfers WHERE ref = ? AND telco = ?").get(m[1], telco) as Record<string, string | number> | undefined;
    if (!r) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
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
  if (/^(collection|disbursement)\/v1_0\/account\/balance$/.test(path)) {
    return { availableBalance: cedis(merchant(w, req, telco).balance), currency: "GHS" };
  }
  if ((m = path.match(/^(collection|disbursement)\/v1_0\/accountholder\/msisdn\/(\d+)\/(active|basicuserinfo)$/))) {
    const wallet = walletByMsisdn(w, normalizeMsisdn(m[2]));
    if (m[3] === "active") return { result: !!wallet && wallet.status === "active" && wallet.telco === telco };
    if (!wallet || wallet.telco !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "Account holder not found");
    const [given, ...rest] = wallet.display_name.split(" ");
    return { given_name: given, family_name: rest.join(" "), name: wallet.display_name };
  }
  return momoError(404, "NOT_FOUND", `No such endpoint: GET ${path}`);
});
