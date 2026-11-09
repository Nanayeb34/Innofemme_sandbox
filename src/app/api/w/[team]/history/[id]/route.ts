import { authWorld, handle } from "@/server/http";
import { undoChange } from "@/engine/config/store";
import { withLock } from "@/engine/world";

/** POST undoes the change. */
export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/history/[id]">) => {
  const { team, id } = await ctx.params;
  const w = await authWorld(req, team);
  const changeId = await withLock(w, () => undoChange(w.db, Number(id), "console"));
  return { ok: true, changeId };
});
