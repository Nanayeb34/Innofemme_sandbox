import { HttpError, body, handle, isOrganiser } from "@/server/http";
import { resetWorld, worldIds } from "@/engine/worlds";

/** POST { action: "reset", worlds: string[] }: wipe the chosen worlds back to an empty country. */
export const POST = handle(async (req: Request) => {
  if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
  const b = await body<{ action: string; worlds?: string[] }>(req);
  if (b.action !== "reset") throw new HttpError(400, "Unknown action");
  const targets = (b.worlds ?? []).filter((id) => worldIds().includes(id));
  if (!targets.length) throw new HttpError(400, "Choose at least one world to reset");
  const results: Record<string, string> = {};
  for (const id of targets) {
    await resetWorld(id);
    results[id] = "ok";
  }
  return { ok: true, results };
});
