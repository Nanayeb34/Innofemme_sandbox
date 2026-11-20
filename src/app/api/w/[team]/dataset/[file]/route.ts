import { DATASET_FILES, datasetCsv } from "@/engine/dataset";
import { simulatedSummary } from "@/engine/worlds";
import { HttpError, authWorld, handle } from "@/server/http";

/**
 * GET /api/w/{team}/dataset/{file}.csv: one file of the simulated history.
 * Add ?answers=0 to leave out the columns that say which transactions are fraud.
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/w/[team]/dataset/[file]">) => {
  const { team, file } = await ctx.params;
  const w = await authWorld(req, team);
  const name = file.replace(/\.csv$/, "");
  if (!Object.hasOwn(DATASET_FILES, name)) throw new HttpError(404, `No such file. Files: ${Object.keys(DATASET_FILES).map((f) => `${f}.csv`).join(", ")}`);
  if (!simulatedSummary(w)) throw new HttpError(404, "No simulated data has been loaded into this world");
  const rows = datasetCsv(w, name, new URL(req.url).searchParams.get("answers") !== "0");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = rows.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
  return new Response(stream, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
});
