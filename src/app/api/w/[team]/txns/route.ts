import { authWorld, handle } from "@/server/http";
import { feed } from "@/server/views";

/** GET ?limit=200&before=<ISO time>&status=held&msisdn=024... (no fraud labels) */
export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/txns">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const q = new URL(req.url).searchParams;
  const before = q.get("before");
  return {
    transactions: feed(w, {
      limit: Number(q.get("limit") ?? 100),
      before: before ? Date.parse(before) : undefined,
      status: q.get("status") ?? undefined,
      wallet: q.get("msisdn") ? `w_${q.get("msisdn")}` : undefined,
    }),
  };
});
