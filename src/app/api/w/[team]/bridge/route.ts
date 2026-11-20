import { authWorld, body, handle } from "@/server/http";
import { listBridges, pollBridge, replyBridge } from "@/engine/bridge";

/**
 * The bridge: how an API on a team's laptop is reached. The bridge program (examples/bridge.py or
 * bridge.mjs) calls here with the team key and is held until the sandbox has something for the API.
 *   POST { action: "poll",  name, session, to }                 → { requests: [{ id, method, path, headers, body }] }, or { replaced: true }
 *   POST { action: "reply", name, session, id, status, body }   what the API answered (or { error } if it could not be asked)
 *   GET                                                         the team's bridges and whether each is connected
 * Anything typed as bridge://{name} then goes to that laptop.
 */
type Ctx = RouteContext<"/api/w/[team]/bridge">;

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const b = await body(req);
  if (b.action === "reply") return replyBridge(w.id, b);
  return pollBridge(w.id, b, req.signal);
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  return { bridges: listBridges(w.id) };
});
