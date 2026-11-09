import { authWorld, body, handle, HttpError } from "@/server/http";
import { ussd } from "@/engine/ussd";
import { withLock } from "@/engine/world";
import { normalizeMsisdn } from "@/engine/util";

export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/ussd">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const b = await body<{ sessionId?: string; msisdn?: string; input?: string }>(req);
  if (!b.msisdn || typeof b.input !== "string") throw new HttpError(400, "msisdn and input are required");
  return withLock(w, () => ussd(w, { sessionId: b.sessionId, msisdn: normalizeMsisdn(b.msisdn!), input: b.input!.slice(0, 182) }));
});
