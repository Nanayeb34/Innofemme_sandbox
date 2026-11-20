import { authWorld, handle } from "@/server/http";
import { restoreSnapshot } from "@/engine/worlds";

/** POST restores the snapshot (rollback). */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/snapshots/[id]">) => {
  const { team, id } = await ctx.params;
  await authWorld(req, team);
  await restoreSnapshot(team, id);
  return { ok: true };
});
