import { authWorld, body, handle, HttpError } from "@/server/http";
import { getLlm } from "@/server/assistant/llm";
import { isBusy, runTurn } from "@/server/assistant/run";
import { chatEvents, deleteChat, getChat, listChats, newChat, usageToday, type ChatEvent } from "@/server/assistant/store";

/**
 * The assistant: a small team of AI agents that works in a team's world on the team's instructions.
 *   GET                      whether it is switched on, the team's conversations, and how much it has been used today
 *   GET ?chat={id}           one conversation: everything shown in it so far, and anything waiting for approval
 *   POST { text, chat? }     say something; the answer comes back as a stream of events as the work happens
 *   POST { chat, approve }   approve something the assistant asked to do (or { chat, decline })
 *   DELETE ?chat={id}        remove a conversation
 * Only the team's own key opens it: not the phone or agent QR codes.
 */
type Ctx = RouteContext<"/api/w/[team]/assistant">;

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const llm = getLlm();
  const id = new URL(req.url).searchParams.get("chat");
  const chat = id ? getChat(w.id, id) : undefined;
  if (id && !chat) throw new HttpError(404, "No such conversation");
  return {
    enabled: !!llm,
    chats: listChats(w.id),
    usedToday: usageToday(w.id).calls,
    chat: chat ? { id: chat.id, title: chat.title, busy: isBusy(chat.id), waiting: chat.pending.map((p) => ({ id: p.id, summary: p.summary })), events: chatEvents(chat.id) } : undefined,
  };
});

export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const id = new URL(req.url).searchParams.get("chat");
  if (id) deleteChat(w.id, id);
  return { ok: true };
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const b = await body<{ chat?: string; text?: string; approve?: string; decline?: string }>(req);
  const text = typeof b.text === "string" ? b.text : undefined;
  if (!text?.trim() && !b.approve && !b.decline) throw new HttpError(400, "Say something, or answer a request for approval");
  const chat = b.chat ? getChat(w.id, b.chat) : newChat(w.id, (text ?? "Conversation").trim().replace(/\s+/g, " ").slice(0, 60));
  if (!chat) throw new HttpError(404, "No such conversation");

  // The work is done while the answer is being sent: each event goes out the moment it happens.
  const stop = new AbortController();
  req.signal.addEventListener("abort", () => stop.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      let open = true;
      const write = (line: string) => {
        if (!open) return;
        try {
          out.enqueue(encoder.encode(line));
        } catch {
          open = false;
        }
      };
      const send = (e: ChatEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
      // Something every few seconds keeps the connection from being closed as idle while the model thinks.
      const beat = setInterval(() => write(": still working\n\n"), 10_000);
      send({ type: "chat", id: chat.id, title: chat.title });
      try {
        await runTurn({ team: w.id, chat, origin: `http://127.0.0.1:${process.env.PORT ?? 3000}`, signal: stop.signal, send }, { text, approve: b.approve, decline: b.decline });
      } finally {
        clearInterval(beat);
        open = false;
        try {
          out.close();
        } catch {
          // already closed by the browser
        }
      }
    },
    cancel() {
      stop.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
});
