import { authWorld, body, handle, HttpError } from "@/server/http";
import { fastForward } from "@/engine/sim";
import { resetWorld, setRunning, setSpeed } from "@/engine/worlds";
import { withLock } from "@/engine/world";
import { worldState } from "@/server/views";

export const maxDuration = 300;

/** POST { action: "fast_forward", hours } | { action: "pause" | "resume" | "reset" } | { action: "speed", speed } */
export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/sim">) => {
  const { team } = await ctx.params;
  let w = await authWorld(req, team);
  const b = await body<{ action: string; hours?: number; speed?: number }>(req);
  switch (b.action) {
    case "fast_forward": {
      const hours = Number(b.hours ?? 24);
      if (!(hours > 0 && hours <= 24 * 7)) throw new HttpError(400, "hours must be between 0 and 168");
      const t = Date.now();
      await withLock(w, () => fastForward(w, hours));
      return { ...worldState(w), tookMs: Date.now() - t };
    }
    case "pause":
    case "resume":
      await withLock(w, () => setRunning(w, b.action === "resume"));
      break;
    case "speed":
      await withLock(w, () => setSpeed(w, Number(b.speed)));
      break;
    case "reset":
      w = await resetWorld(team);
      break;
    default:
      throw new HttpError(400, "Unknown action");
  }
  return worldState(w);
});
