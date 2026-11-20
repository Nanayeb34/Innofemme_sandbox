import { DATASET_FILES, datasetRows } from "@/engine/dataset";
import { SCENARIOS } from "@/engine/simulate";
import { simulatedSummary } from "@/engine/worlds";
import { authWorld, handle, publicOrigin } from "@/server/http";

/** GET /api/w/{team}/dataset: what the simulated history in this world holds, and the files it can be downloaded as. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/dataset">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const summary = simulatedSummary(w);
  if (!summary) return { loaded: false };
  const base = `${publicOrigin(req)}/api/w/${team}/dataset`;
  return {
    loaded: true,
    summary,
    scenarios: Object.entries(SCENARIOS).map(([id, about]) => ({ id, about, ...summary.byScenario[id] })),
    files: Object.entries(DATASET_FILES).map(([name, f]) => ({ name: `${name}.csv`, about: f.about, rows: datasetRows(w, name), url: `${base}/${name}.csv` })),
  };
});
