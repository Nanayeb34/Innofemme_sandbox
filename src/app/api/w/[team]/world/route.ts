import { authWorld, body, handle, HttpError } from "@/server/http";
import { resetWorld } from "@/engine/worlds";

/** POST { action: "reset" } wipes the team's world back to an empty country. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/world">) => {
  const { team } = await ctx.params;
  await authWorld(req, team);
  const b = await body<{ action: string }>(req);
  if (b.action !== "reset") throw new HttpError(400, "Unknown action");
  await resetWorld(team);
  return { ok: true };
});
