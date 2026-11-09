import { HttpError, handle, isOrganiser } from "@/server/http";
import { getWorld, isRunning, registry, speedOf, startTicker, ORGANISER_WORLD } from "@/engine/worlds";
import { metrics } from "@/engine/scoring";
import { hiddenScenarios } from "@/engine/sim";
import { DAY } from "@/engine/util";

/** Organiser view: every world's metrics, including hidden ground-truth breakdowns. */
export const GET = handle(async (req: Request) => {
  if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
  startTicker();
  const reg = registry();
  const origin = new URL(req.url).origin;
  const worlds = [...reg.teams.map((t) => ({ id: t.id, name: t.name, key: t.key })), { id: ORGANISER_WORLD, name: "Organiser world", key: "" }];
  return {
    organiserKey: reg.organiserKey,
    teams: worlds.map((t) => {
      const w = getWorld(t.id);
      return {
        id: t.id,
        name: t.name,
        joinUrl: t.key ? `${origin}/join/${t.id}?k=${t.key}` : null,
        consoleUrl: t.key ? `${origin}/join/${t.id}?k=${t.key}&to=console` : `${origin}/t/${t.id}/console`,
        key: t.key,
        simTime: new Date(w.now).toISOString(),
        running: isRunning(w),
        speed: speedOf(w),
        changes: (w.db.prepare("SELECT COUNT(*) AS n FROM config_history").get() as { n: number }).n,
        hidden: hiddenScenarios(w),
        overall: metrics(w),
        last24h: metrics(w, w.now - DAY, w.now + 1),
        byScenario: w.db.prepare("SELECT scenario, status, COUNT(*) AS n, SUM(amount) AS value FROM txns WHERE is_fraud = 1 GROUP BY scenario, status").all(),
      };
    }),
  };
});
