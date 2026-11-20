import { HttpError, body, handle } from "@/server/http";
import { issueToken, requirePartner } from "@/server/partner-auth";
import { getConfig } from "@/engine/config/store";
import { accountByNumber, getTxn, walletByMsisdn } from "@/engine/ledger";
import { switchLog } from "@/engine/switch";
import { locked } from "@/engine/integrations";
import { PARTICIPANTS, bankName, isTelco, normalizeMsisdn, participantName } from "@/engine/util";

/**
 * The national switch's API for licensed institutions (GhIPSS in real life). Payments themselves
 * are sent through the institution's bank or network, which routes them here.
 * Base URL: /api/w/{team}/ghipss
 *   POST token                      client id + API key (Basic) → bearer token
 *   GET  v1/participants            the banks and networks on the switch, and whether each is connected
 *   POST v1/name-enquiry            { accountNumber } or { msisdn } → the institution and the name
 *   GET  v1/transactions/{id}       the status of a routed payment, and the switch's messages for it
 */

type Ctx = RouteContext<"/api/w/[team]/ghipss/[...path]">;
const INSTITUTION = "switch";

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, path: parts } = await ctx.params;
  const path = parts.join("/").replace(/\/$/, "");
  if (path === "token") return issueToken(req, team, INSTITUTION);
  const { w, client } = requirePartner(req, team, INSTITUTION);
  if (path !== "v1/name-enquiry") throw new HttpError(404, `No such endpoint: POST ${path}`);
  const b = await body(req);
  return locked(w, () => {
    if (b.msisdn) {
      const wallet = walletByMsisdn(w, normalizeMsisdn(String(b.msisdn)));
      if (!wallet) throw new HttpError(404, "No mobile money wallet on that number");
      switchLog(w, null, "lookup", null, wallet.telco, `name enquiry for ${wallet.msisdn} by ${client.name}`);
      return { type: "wallet", msisdn: wallet.msisdn, name: wallet.display_name, institutionCode: wallet.telco, institutionName: participantName(wallet.telco), status: wallet.status };
    }
    const a = b.accountNumber ? accountByNumber(w, String(b.accountNumber)) : undefined;
    if (!a || a.kind !== "personal") throw new HttpError(b.accountNumber ? 404 : 400, b.accountNumber ? "Account not found" : "Send accountNumber or msisdn");
    switchLog(w, null, "lookup", null, a.bank, `name enquiry for account ${a.account_no} by ${client.name}`);
    return { type: "bank_account", accountNumber: a.account_no, name: a.name, institutionCode: a.bank, institutionName: bankName(a.bank), status: a.status };
  });
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, path: parts } = await ctx.params;
  const path = parts.join("/").replace(/\/$/, "");
  const { w } = requirePartner(req, team, INSTITUTION);
  if (path === "v1/participants") {
    const cfg = getConfig(w.db, "switch");
    return { participants: PARTICIPANTS.map((p) => ({ code: p, name: participantName(p), type: isTelco(p) ? "mobile_money" : "bank", connected: !!cfg.participants[p]?.connected })) };
  }
  const m = path.match(/^v1\/transactions\/([\w-]+)$/);
  if (m) {
    const t = getTxn(w, m[1]);
    if (!t || t.rail !== "switch") throw new HttpError(404, "No routed payment with that id");
    const steps = w.db.prepare("SELECT step, detail, at FROM switch_log WHERE txn_id = ? ORDER BY id").all(t.id) as { step: string; detail: string; at: number }[];
    return {
      transactionId: t.id, status: t.status === "success" ? "SUCCESSFUL" : t.status.toUpperCase(), amount: t.amount / 100, currency: "GHS",
      from: t.from_party ? participantName(t.from_party) : undefined, to: t.to_party ? participantName(t.to_party) : undefined, reason: t.reason ?? undefined,
      messages: steps.map((s) => ({ step: s.step, detail: s.detail, at: new Date(s.at).toISOString() })),
    };
  }
  throw new HttpError(404, `No such endpoint: GET ${path}`);
});
