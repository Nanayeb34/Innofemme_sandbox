import { authWorld, handle } from "@/server/http";
import { diffJson, getConfig } from "@/engine/config/store";
import type { Surface } from "@/engine/config/schemas";

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/proposals">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const rows = w.db.prepare("SELECT id, surface, after, summary, status, created_at FROM proposals ORDER BY id DESC LIMIT 20").all() as {
    id: number;
    surface: Surface;
    after: string;
    summary: string;
    status: string;
    created_at: number;
  }[];
  return {
    proposals: rows.map((r) => ({
      id: r.id,
      surface: r.surface,
      summary: r.summary,
      status: r.status,
      createdAt: r.created_at,
      diff: r.status === "pending" ? diffJson(getConfig(w.db, r.surface), JSON.parse(r.after)) : [],
    })),
  };
});
