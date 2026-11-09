import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError, authWorld, handle } from "@/server/http";
import { teamById } from "@/engine/worlds";
import { getWallet, transfer, walletByMsisdn } from "@/engine/payments";
import { createRtp, getRtp, rtpView } from "@/engine/rtp";
import { withLock, type World } from "@/engine/world";
import { TELCOS, normalizeMsisdn, type Telco } from "@/engine/util";
import { cedis } from "@/engine/notify";

/**
 * Telco-style Open API modelled on MTN MoMo (collection + disbursement products).
 * Base URL: /api/w/{team}/momo/{mtn|telecel|at}
 * Telecel and AT use the same shape until their own specifications are received.
 */

const SHOP = { mtn: "w_0249900010", telecel: "w_0209900010", at: "w_0269900010" } as const;
const tokens = ((globalThis as unknown as { __momoTokens?: Map<string, { team: string; exp: number }> }).__momoTokens ??= new Map());

type Ctx = RouteContext<"/api/w/[team]/momo/[telco]/[...path]">;

async function setup(req: Request, ctx: Ctx) {
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
  const { team, telco, path } = await setup(req, ctx);

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
    const payer = b.payer as { partyIdType?: string; partyId?: string } | undefined;
    const amount = amountOf(b.amount);
    if (!amount || !payer?.partyId) return momoError(400, "INVALID_INPUT", "amount and payer.partyId are required");
    if (b.currency && b.currency !== "GHS") return momoError(400, "INVALID_CURRENCY", "Currency must be GHS");
    if (getRtp(w, ref)) return momoError(409, "RESOURCE_ALREADY_EXIST", "Duplicated reference id");
    await withLock(w, () =>
      createRtp(w, {
        ref,
        payeeWallet: SHOP[telco],
        payerMsisdn: normalizeMsisdn(payer.partyId!),
        amount,
        externalId: b.externalId as string,
        payerMessage: b.payerMessage as string,
        payeeNote: b.payeeNote as string,
        callbackUrl,
      }),
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
    await withLock(w, async () => {
      const to = walletByMsisdn(w, msisdn);
      const r = to
        ? await transfer(w, { type: "p2p", channel: "api", initiatedBy: "api", from: SHOP[telco], to: to.id, amount, reference: (b.payerMessage as string) ?? undefined })
        : { status: "failed", message: "PAYEE_NOT_FOUND", txnId: undefined };
      const ok = r.status === "success" || r.status === "held";
      w.db
        .prepare("INSERT INTO api_transfers(ref, telco, payee_msisdn, amount, external_id, payer_message, payee_note, status, reason, txn_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(ref, telco, msisdn, amount, (b.externalId as string) ?? null, (b.payerMessage as string) ?? null, (b.payeeNote as string) ?? null, ok ? "SUCCESSFUL" : "FAILED", ok ? null : r.message, r.txnId ?? null, w.now);
    });
    return new Response(null, { status: 202 });
  }

  return momoError(404, "NOT_FOUND", `No such endpoint: POST ${path}`);
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(req, ctx);
  const w = await authed(req, team);
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^collection\/v1_0\/requesttopay\/([\w-]+)$/))) {
    const r = getRtp(w, m[1]);
    if (!r || r.telco !== telco) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return rtpView(r);
  }
  if ((m = path.match(/^disbursement\/v1_0\/transfer\/([\w-]+)$/))) {
    const r = w.db.prepare("SELECT * FROM api_transfers WHERE ref = ? AND telco = ?").get(m[1], telco) as Record<string, string | number> | undefined;
    if (!r) return momoError(404, "RESOURCE_NOT_FOUND", "Requested resource was not found");
    return {
      amount: cedis(r.amount as number),
      currency: "GHS",
      financialTransactionId: r.txn_id ?? undefined,
      externalId: r.external_id ?? undefined,
      payee: { partyIdType: "MSISDN", partyId: "233" + String(r.payee_msisdn).slice(1) },
      payerMessage: r.payer_message ?? undefined,
      payeeNote: r.payee_note ?? undefined,
      status: r.status,
      reason: r.reason ?? undefined,
    };
  }
  if (/^(collection|disbursement)\/v1_0\/account\/balance$/.test(path)) {
    return { availableBalance: cedis(getWallet(w, SHOP[telco])!.balance), currency: "GHS" };
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
