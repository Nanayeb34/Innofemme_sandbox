import { authWorld, handle, HttpError } from "@/server/http";
import { phoneState } from "@/server/views";
import { normalizeMsisdn } from "@/engine/util";

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/phone/[msisdn]">) => {
  const { team, msisdn } = await ctx.params;
  const w = await authWorld(req, team);
  const state = phoneState(w, normalizeMsisdn(msisdn));
  if (!state) throw new HttpError(404, "Number not found in this world");
  return state;
});
