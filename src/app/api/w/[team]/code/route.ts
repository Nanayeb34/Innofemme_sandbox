import { createCode, warmCode } from "@/engine/coderun";
import { overview } from "@/server/developer";
import { authWorld, body, handle } from "@/server/http";

/** GET /api/w/{team}/code: the team's own plug-ins, the languages this server runs, and where plug-ins can go. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/code">) => {
  const { team } = await ctx.params;
  return overview(await authWorld(req, team));
});

/** POST /api/w/{team}/code { name, language, source }: a new plug-in. It is started straight away, so a mistake shows at once. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/code">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const meta = createCode(w.id, await body(req));
  return { ...meta, started: await warmCode(w.id, meta.id) };
});
