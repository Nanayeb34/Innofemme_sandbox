import { authWorld, body, handle } from "@/server/http";
import { resolveSystem } from "@/server/systems";
import { SimError } from "@/engine/util";
import { withLock } from "@/engine/world";

type Ctx = RouteContext<"/api/w/[team]/s/[...sys]">;

/** GET /api/w/{team}/s/{system}: what that institution's console shows. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, sys } = await ctx.params;
  const w = await authWorld(req, team);
  const system = resolveSystem(sys);
  return withLock(w, () => system.view(w, new URL(req.url).searchParams));
});

/** POST /api/w/{team}/s/{system} { action, ...fields }: something that institution's staff do. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, sys } = await ctx.params;
  const w = await authWorld(req, team);
  const system = resolveSystem(sys);
  const b = await body(req);
  const action = system.actions[String(b.action)];
  if (!action) throw new SimError(`Unknown action. This system supports: ${Object.keys(system.actions).join(", ")}`);
  return withLock(w, () => action(w, b));
});
