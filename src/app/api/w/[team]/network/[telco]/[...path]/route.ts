import { HttpError, body, handle } from "@/server/http";
import { issueToken, requirePartner } from "@/server/partner-auth";
import { kycMatch, simSwapCheck, simSwapDate, subscriber } from "@/engine/signals";
import { appSmsSent, sendAppSms, senderIdOf } from "@/engine/sms";
import { withLock } from "@/engine/world";
import { isTelco } from "@/engine/util";

/**
 * The network partner API: what a telco gives a licensed messaging or verification company.
 * Base URL: /api/w/{team}/network/{mtn|telecel|at}
 *   POST token                       client id + API key (Basic) → bearer token
 *   POST v1/sms/messages             send a text under the partner's registered sender name
 *   GET  v1/sms/messages             what the partner has sent
 *   GET  v1/subscribers/{msisdn}     who the number is registered to, and its status
 *   POST v1/sim-swap/check           was the SIM replaced within maxAge hours?
 *   POST v1/sim-swap/retrieve-date   when the SIM was last replaced
 *   POST v1/kyc-match                do these details match the network's records? (true/false per field)
 * A network answers only for its own numbers.
 */

type Ctx = RouteContext<"/api/w/[team]/network/[telco]/[...path]">;

async function setup(ctx: Ctx) {
  const { team, telco, path } = await ctx.params;
  if (!isTelco(telco)) throw new HttpError(404, "Unknown network. Use mtn, telecel or at.");
  return { team, telco, path: path.join("/").replace(/\/$/, "") };
}

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  if (path === "token") return issueToken(req, team, telco);
  const { w, client } = requirePartner(req, team, telco);
  const b = await body(req);
  return withLock(w, () => {
    switch (path) {
      case "v1/sms/messages": {
        const r = sendAppSms(w, { display_name: client.name, telco }, { to: b.to as string, text: b.text });
        return { status: r.delivered ? "delivered" : "failed", reason: r.reason, parts: r.parts, senderId: r.senderId, to: r.to };
      }
      case "v1/sim-swap/check":
        return simSwapCheck(w, telco, b);
      case "v1/sim-swap/retrieve-date":
        return simSwapDate(w, telco, b);
      case "v1/kyc-match":
        return kycMatch(w, telco, b);
    }
    throw new HttpError(404, `No such endpoint: POST ${path}`);
  });
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, telco, path } = await setup(ctx);
  const { w, client } = requirePartner(req, team, telco);
  const m = path.match(/^v1\/subscribers\/(\d+)$/);
  if (m) return subscriber(w, telco, m[1]);
  if (path === "v1/sms/messages") return { senderId: senderIdOf({ display_name: client.name }), messages: appSmsSent(w, { display_name: client.name, telco }) };
  throw new HttpError(404, `No such endpoint: GET ${path}`);
});
