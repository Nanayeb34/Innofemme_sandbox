import { clearLogs, clearStore, saveCode, stopCode, warmCode } from "@/engine/coderun";
import { SimError } from "@/engine/util";
import { detail, plug, remove, tryIt, unplug } from "@/server/developer";
import { authWorld, body, handle } from "@/server/http";

type Ctx = RouteContext<"/api/w/[team]/code/[id]">;

/** GET: the code, whether it is running, its output, where it is plugged in, and the questions it was asked. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, id } = await ctx.params;
  return detail(await authWorld(req, team), id);
});

/** PUT { name?, source? }: saves the code. The new version is started at once to catch mistakes. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { team, id } = await ctx.params;
  const w = await authWorld(req, team);
  const meta = saveCode(w.id, id, await body(req));
  return { ...meta, started: await warmCode(w.id, id) };
});

export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { team, id } = await ctx.params;
  await remove(await authWorld(req, team), id);
  return { ok: true };
});

/** POST { action: "try" | "plug" | "unplug" | "restart" | "clear_logs" | "clear_store", ... } */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, id } = await ctx.params;
  const w = await authWorld(req, team);
  const b = await body<Record<string, unknown>>(req);
  switch (b.action) {
    case "try":
      return tryIt(w, id, String(b.point ?? ""), String(b.institution ?? ""));
    case "plug":
      await plug(w, id, b);
      return { ok: true, message: "Plugged in. From now on it is asked at this step." };
    case "unplug":
      await unplug(w, id, b.integration);
      return { ok: true, message: "Unplugged." };
    case "restart":
      stopCode(w.id, id, "Restarted.");
      return { ok: true, started: await warmCode(w.id, id) };
    case "clear_logs":
      clearLogs(w.id, id);
      return { ok: true };
    case "clear_store":
      clearStore(w.id, id);
      return { ok: true, message: "What the plug-in kept in its store is gone." };
    default:
      throw new SimError("Unknown action. Use try, plug, unplug, restart, clear_logs or clear_store.");
  }
});
