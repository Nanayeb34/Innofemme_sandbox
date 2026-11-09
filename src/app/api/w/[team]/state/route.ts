import { authWorld, handle } from "@/server/http";
import { directory, feed, personas, worldState } from "@/server/views";

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/state">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const url = new URL(req.url);
  return {
    ...worldState(w),
    personas: personas(w),
    feed: feed(w, { limit: Number(url.searchParams.get("limit") ?? 40) }),
    ...(url.searchParams.has("directory") ? { directory: directory(w) } : {}),
  };
});
