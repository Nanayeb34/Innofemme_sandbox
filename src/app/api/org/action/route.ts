import { HttpError, body, handle, isOrganiser } from "@/server/http";
import { loadSimulated, resetWorld, worldIds } from "@/engine/worlds";

/**
 * POST { action: "reset", worlds: string[] }: wipe the chosen worlds back to an empty country.
 * POST { action: "simulate", worlds: string[], seed?: number }: load the simulated country into them.
 * A different seed gives a different country, for example one kept back to judge detectors on.
 */
export const POST = handle(async (req: Request) => {
  if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
  const b = await body<{ action: string; worlds?: string[]; seed?: number }>(req);
  if (b.action !== "reset" && b.action !== "simulate") throw new HttpError(400, "Unknown action");
  const targets = (b.worlds ?? []).filter((id) => worldIds().includes(id));
  if (!targets.length) throw new HttpError(400, "Choose at least one world");
  const seed = b.seed === undefined ? undefined : Math.floor(Number(b.seed));
  if (seed !== undefined && !(seed > 0 && seed < 2 ** 31)) throw new HttpError(400, "The seed must be a whole number above zero");
  const results: Record<string, string> = {};
  for (const id of targets) {
    if (b.action === "simulate") await loadSimulated(id, seed);
    else await resetWorld(id);
    results[id] = "ok";
  }
  return { ok: true, results };
});
