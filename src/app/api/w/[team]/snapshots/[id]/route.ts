import { authWorld, handle } from "@/server/http";
import { restoreSnapshot } from "@/engine/worlds";
import { worldState } from "@/server/views";

/** POST restores the snapshot (rollback). */
export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/snapshots/[id]">) => {
  const { team, id } = await ctx.params;
  await authWorld(req, team);
  return worldState(await restoreSnapshot(team, id));
});
