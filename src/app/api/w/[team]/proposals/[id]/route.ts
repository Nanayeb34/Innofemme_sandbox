import { authWorld, body, handle, HttpError } from "@/server/http";
import { setConfig } from "@/engine/config/store";
import type { Surface } from "@/engine/config/schemas";
import { withLock } from "@/engine/world";

/** POST { action: "apply" | "discard" } */
export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/proposals/[id]">) => {
  const { team, id } = await ctx.params;
  const w = await authWorld(req, team);
  const { action } = await body<{ action: string }>(req);
  return withLock(w, () => {
    const p = w.db.prepare("SELECT * FROM proposals WHERE id = ?").get(Number(id)) as { id: number; surface: Surface; after: string; summary: string; status: string } | undefined;
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "pending") throw new HttpError(409, `Proposal already ${p.status}`);
    if (action === "discard") {
      w.db.prepare("UPDATE proposals SET status = 'discarded' WHERE id = ?").run(p.id);
      return { ok: true };
    }
    if (action !== "apply") throw new HttpError(400, "action must be apply or discard");
    const changeId = setConfig(w.db, p.surface, JSON.parse(p.after), p.summary, "assistant");
    w.db.prepare("UPDATE proposals SET status = 'applied' WHERE id = ?").run(p.id);
    return { ok: true, changeId };
  });
});
