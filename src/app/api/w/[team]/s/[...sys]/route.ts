import { authWorld, body, handle } from "@/server/http";
import { resolveSystem } from "@/server/systems";
import { SimError } from "@/engine/util";
import { locked } from "@/engine/integrations";
import { withLock } from "@/engine/world";
import type { Role } from "@/engine/worlds";

type Ctx = RouteContext<"/api/w/[team]/s/[...sys]">;

/** The phone QR codes carry narrower keys: a customer key reaches only the phone, an agent key only the agent screens. */
function rolesFor(sys: string[]): Role[] {
  if (sys[0] === "phone") return ["team", "customer"];
  if (sys[0] === "momo-agent" || sys[0] === "sim-agent") return ["team", "agent"];
  return ["team"];
}

/** GET /api/w/{team}/s/{system}: what that institution's console shows. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, sys } = await ctx.params;
  const w = await authWorld(req, team, rolesFor(sys));
  const system = resolveSystem(sys);
  return withLock(w, () => system.view(w, new URL(req.url).searchParams));
});

/** POST /api/w/{team}/s/{system} { action, ...fields }: something that institution's staff do. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, sys } = await ctx.params;
  const w = await authWorld(req, team, rolesFor(sys));
  const system = resolveSystem(sys);
  const b = await body(req);
  const staged = system.staged?.[String(b.action)];
  if (staged) return staged(w, b);
  const action = system.actions[String(b.action)];
  if (!action) throw new SimError(`Unknown action. This system supports: ${[...Object.keys(system.actions), ...Object.keys(system.staged ?? {})].join(", ")}`);
  return locked(w, () => action(w, b));
});
