import { authWorld, handle } from "@/server/http";
import { diffJson } from "@/engine/config/store";

/** Settings changes, newest first. ?surface=telco.mtn narrows to one institution. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/history">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const surface = new URL(req.url).searchParams.get("surface");
  const rows = (surface
    ? w.db.prepare("SELECT * FROM config_history WHERE surface = ? ORDER BY id DESC LIMIT 40").all(surface)
    : w.db.prepare("SELECT * FROM config_history ORDER BY id DESC LIMIT 40").all()) as { id: number; surface: string; before: string; after: string; summary: string; author: string; at: number; undone_by: number | null }[];
  return {
    changes: rows.map((r) => ({ id: r.id, surface: r.surface, summary: r.summary, author: r.author, at: new Date(r.at).toISOString(), undone: !!r.undone_by, diff: diffJson(JSON.parse(r.before), JSON.parse(r.after)).slice(0, 12) })),
  };
});
