import { authWorld, handle } from "@/server/http";
import { iceConfig } from "@/server/ice";

/** What a phone's browser needs to connect call audio: address discovery, and a relay when one is configured. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/ice">) => {
  const { team } = await ctx.params;
  await authWorld(req, team);
  return iceConfig();
});
