import { HttpError, body, handle, isOrganiser } from "@/server/http";
import { getWorld, resetWorld, setRunning, setSpeed, worldIds } from "@/engine/worlds";
import { setMeta } from "@/engine/db";
import { fastForward } from "@/engine/sim";
import { SCENARIO_IDS } from "@/engine/config/schemas";
import { withLock } from "@/engine/world";

/**
 * POST { action, worlds?: string[] (default all), ... }
 *  - surprise { scenario, perDay }  hidden scenario teams cannot see or switch off
 *  - clear_surprise
 *  - pause | resume | speed { speed } | fast_forward { hours } | reset
 */
export const POST = handle(async (req: Request) => {
  if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
  const b = await body<{ action: string; worlds?: string[]; scenario?: string; perDay?: number; speed?: number; hours?: number }>(req);
  const targets = (b.worlds?.length ? b.worlds : worldIds()).filter((id) => worldIds().includes(id));
  const results: Record<string, string> = {};
  for (const id of targets) {
    const w = getWorld(id);
    switch (b.action) {
      case "surprise":
        if (!SCENARIO_IDS.includes(b.scenario as never)) throw new HttpError(400, "Unknown scenario");
        await withLock(w, () => setMeta(w.db, "hidden_scenarios", JSON.stringify([{ id: b.scenario, perDay: Number(b.perDay ?? 30) }])));
        break;
      case "clear_surprise":
        await withLock(w, () => setMeta(w.db, "hidden_scenarios", "[]"));
        break;
      case "pause":
      case "resume":
        await withLock(w, () => setRunning(w, b.action === "resume"));
        break;
      case "speed":
        await withLock(w, () => setSpeed(w, Number(b.speed)));
        break;
      case "fast_forward":
        await withLock(w, () => fastForward(w, Math.min(168, Number(b.hours ?? 24))));
        break;
      case "reset":
        await resetWorld(id);
        break;
      default:
        throw new HttpError(400, "Unknown action");
    }
    results[id] = "ok";
  }
  return { ok: true, results };
});
