import { authWorld, body, handle } from "@/server/http";
import { listSnapshots, snapshotWorld } from "@/engine/worlds";

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/snapshots">) => {
  const { team } = await ctx.params;
  await authWorld(req, team);
  return { snapshots: listSnapshots(team) };
});

export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/snapshots">) => {
  const { team } = await ctx.params;
  await authWorld(req, team);
  const { label } = await body<{ label?: string }>(req);
  return snapshotWorld(team, label ?? "Snapshot");
});
