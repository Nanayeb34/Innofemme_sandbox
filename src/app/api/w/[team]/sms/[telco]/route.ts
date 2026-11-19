import { HttpError, authWorld, body, handle } from "@/server/http";
import { merchantFor } from "@/server/merchant";
import { appSmsSent, sendAppSms, senderIdOf } from "@/engine/sms";
import { withLock } from "@/engine/world";
import { isTelco } from "@/engine/util";

/**
 * Messaging API for businesses: send a text to a customer from your own software.
 * Base URL: /api/w/{team}/sms/{mtn|telecel|at}
 * You act as a merchant that network has onboarded (X-Merchant-Id). The text arrives under the
 * merchant's registered sender name, and the customer cannot reply to it.
 */

type Ctx = RouteContext<"/api/w/[team]/sms/[telco]">;

async function setup(req: Request, ctx: Ctx) {
  const { team, telco } = await ctx.params;
  if (!isTelco(telco)) throw new HttpError(404, "Unknown network. Use mtn, telecel or at.");
  return { w: await authWorld(req, team), telco };
}

/** POST { to, text } → { status: "delivered" | "failed", reason?, parts, senderId, to } */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { w, telco } = await setup(req, ctx);
  const b = await body<{ to?: string; text?: string }>(req);
  return withLock(w, () => {
    const r = sendAppSms(w, merchantFor(w, req, telco), { to: b.to, text: b.text });
    return { status: r.delivered ? "delivered" : "failed", reason: r.reason, parts: r.parts, senderId: r.senderId, to: r.to };
  });
});

/** GET → what this merchant has sent, newest first. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { w, telco } = await setup(req, ctx);
  const merchant = merchantFor(w, req, telco);
  return { senderId: senderIdOf(merchant), messages: appSmsSent(w, merchant) };
});
