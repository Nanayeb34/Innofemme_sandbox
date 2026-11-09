import { authWorld, body, handle, HttpError } from "@/server/http";
import { applyPatch, getConfig, setConfig, type PatchOp } from "@/engine/config/store";
import { SURFACE_NAMES, type Surface } from "@/engine/config/schemas";
import { withLock } from "@/engine/world";

async function resolve(req: Request, ctx: RouteContext<"/api/w/[team]/config/[surface]">) {
  const { team, surface } = await ctx.params;
  if (!(SURFACE_NAMES as string[]).includes(surface)) throw new HttpError(404, `Unknown surface. Use one of: ${SURFACE_NAMES.join(", ")}`);
  return { w: await authWorld(req, team), surface: surface as Surface };
}

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/config/[surface]">) => {
  const { w, surface } = await resolve(req, ctx);
  return getConfig(w.db, surface);
});

/** Replace a whole surface: { value, summary } */
export const PUT = handle(async (req, ctx: RouteContext<"/api/w/[team]/config/[surface]">) => {
  const { w, surface } = await resolve(req, ctx);
  const b = await body<{ value: unknown; summary?: string }>(req);
  const id = await withLock(w, () => setConfig(w.db, surface, b.value, b.summary ?? `Updated ${surface} via API`, "api"));
  return { ok: true, changeId: id };
});

/** JSON Patch: { operations: [{op, path, value}], summary } */
export const PATCH = handle(async (req, ctx: RouteContext<"/api/w/[team]/config/[surface]">) => {
  const { w, surface } = await resolve(req, ctx);
  const b = await body<{ operations: PatchOp[]; summary?: string }>(req);
  if (!Array.isArray(b.operations)) throw new HttpError(400, "operations must be an array");
  const id = await withLock(w, () => setConfig(w.db, surface, applyPatch(getConfig(w.db, surface), b.operations), b.summary ?? `Patched ${surface} via API`, "api"));
  return { ok: true, changeId: id };
});
