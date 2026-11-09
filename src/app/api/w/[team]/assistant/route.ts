import { authWorld, body, handle, HttpError } from "@/server/http";
import { assistantConfigured, chat } from "@/engine/assistant";
import { withLock } from "@/engine/world";

export const maxDuration = 120;

export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/assistant">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const messages = (w.db.prepare("SELECT role, content, at FROM assistant_messages ORDER BY id DESC LIMIT 40").all() as { role: string; content: string; at: number }[]).reverse();
  return { configured: assistantConfigured(), messages };
});

export const POST = handle(async (req, ctx: RouteContext<"/api/w/[team]/assistant">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const { message } = await body<{ message?: string }>(req);
  if (!message?.trim()) throw new HttpError(400, "message is required");
  // The model call runs outside the world lock; only its tool calls touch the database.
  return chat(w, message.trim()).catch((e) => withLock(w, () => ({ text: `The assistant hit an error: ${(e as Error).message}`, proposals: [] })));
});
