import { authWorld, handle } from "@/server/http";
import { changeImpacts } from "@/engine/scoring";

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/history">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  return { changes: changeImpacts(w) };
});
