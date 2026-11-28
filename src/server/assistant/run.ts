import { randomUUID } from "node:crypto";
import { ConfigError } from "@/engine/config/store";
import { SimError } from "@/engine/util";
import { getWorld } from "@/engine/worlds";
import { AGENTS, SPECIALISTS, promptOf, type Agent } from "./agents";
import { AssistantError, getLlm, type Conversation, type Llm, type ToolCall, type ToolSpec } from "./llm";
import { addEvent, countUsage, saveChat, usageToday, type Chat, type ChatEvent, type Pending } from "./store";
import { asText, tool, type ToolContext } from "./tools";

/**
 * One turn of a conversation with the assistant: the person says something (or answers a request for
 * approval), and the lead works until it has an answer, handing pieces of work to specialists on the way.
 *
 * What the person sees, as it happens, is a stream of events:
 *   user        what they said
 *   text        something the lead said to them
 *   agent_start a specialist was handed a piece of work (with the brief)
 *   note        something a specialist said while working
 *   tool        a tool was used (one line saying what)
 *   tool_result how it went
 *   agent_end   the specialist reported back
 *   confirm     the person is asked to approve something first
 *   approved / declined   their answer
 *   notice      something they should know (a limit, a long conversation)
 *   error       the turn could not go on
 *   done        the turn is over
 */

/** How many times one turn may go back to the model, across the lead and every specialist. */
const MAX_CALLS_PER_TURN = 60;
/** No daily limit, unless ASSISTANT_DAILY_CALLS is set to a number above 0. */
const dailyLimit = () => Number(process.env.ASSISTANT_DAILY_CALLS) || Infinity;
const delegateSpec: ToolSpec = {
  name: "delegate",
  description: "Hand a piece of work to a specialist. They know only what you put in the brief, so make it complete: what to do, every number, name, PIN, address and decision they need, and what to report back. They work until it is done and reply with a report.",
  parameters: { type: "object", properties: { to: { type: "string", enum: SPECIALISTS.map((s) => s.id), description: "which specialist" }, brief: { type: "string", description: "the work, in full" } }, required: ["to", "brief"], additionalProperties: false },
};

const running = new Map<string, string>(); // chat id → team

export const isBusy = (chatId: string) => running.has(chatId);

export interface Turn {
  team: string;
  chat: Chat;
  /** This server's own address, for reading its documentation. */
  origin: string;
  signal: AbortSignal;
  /** Sends one event to the person's screen. */
  send(e: ChatEvent): void;
}

export async function runTurn(t: Turn, input: { text?: string; approve?: string; decline?: string }) {
  const emit = (e: ChatEvent) => {
    addEvent(t.chat.id, e);
    t.send(e);
  };
  const llm = getLlm();
  if (!llm) return emit({ type: "error", message: "The assistant is not switched on for this sandbox." });
  if (running.has(t.chat.id)) return t.send({ type: "error", message: "The assistant is still working on your last message in this conversation." });
  if ([...running.values()].filter((team) => team === t.team).length >= 3) return t.send({ type: "error", message: "Your team already has three conversations with the assistant under way. Wait for one to finish." });
  if (usageToday(t.team).calls >= dailyLimit()) return emit({ type: "error", message: "Your team has reached today's limit for the assistant. It starts again tomorrow; the consoles and the API work as always." });

  running.set(t.chat.id, t.team);
  const ctx: ToolContext = { team: t.team, world: () => getWorld(t.team), origin: t.origin, signal: t.signal };
  const run: Run = { t, llm, ctx, emit, calls: 0 };
  try {
    // A conversation begun with another model cannot be carried on with this one: it starts again, keeping what is on screen.
    if (!t.chat.conversation || t.chat.conversation.provider !== llm.provider) t.chat.conversation = llm.start();
    const conv = t.chat.conversation;

    const answered = input.approve ?? input.decline;
    if (answered) {
      const at = t.chat.pending.findIndex((p) => p.id === answered);
      if (at < 0) return emit({ type: "error", message: "That request is no longer waiting for an answer." });
      const [p] = t.chat.pending.splice(at, 1);
      if (input.approve) {
        emit({ type: "approved", id: p.id });
        // Exactly what the person was shown is what is carried out: by the sandbox, not by asking the model to try again.
        const out = await carryOut(run, p.agent, { id: p.id, name: p.tool, input: p.input }, true);
        llm.say(conv, `[I approved this: ${p.summary}]\nIt has been carried out. Result: ${out.content}`);
      } else {
        emit({ type: "declined", id: p.id });
        llm.say(conv, `[I declined this: ${p.summary}]\nDo not do it.`);
      }
    } else {
      const text = (input.text ?? "").trim().slice(0, 6000);
      if (!text) return;
      emit({ type: "user", text });
      llm.say(conv, text);
    }
    saveChat(t.chat);
    await work(run, AGENTS.lead, conv, true);
  } catch (e) {
    if (t.signal.aborted) emit({ type: "notice", text: "Stopped." });
    else if (e instanceof AssistantError) emit({ type: "error", message: e.message });
    else {
      console.error("assistant:", e);
      emit({ type: "error", message: "Something went wrong inside the assistant. Please try again." });
    }
  } finally {
    running.delete(t.chat.id);
    saveChat(t.chat);
    emit({ type: "done", waiting: t.chat.pending.length });
  }
}

interface Run {
  t: Turn;
  llm: Llm;
  ctx: ToolContext;
  emit(e: ChatEvent): void;
  calls: number;
}

/** One agent working until it has nothing more to do. Returns what it said last. */
async function work(run: Run, agent: Agent, conv: Conversation, isLead: boolean): Promise<string> {
  const { t, llm, emit } = run;
  const specs = agent.tools.flatMap((name) => (name === "delegate" ? [delegateSpec] : tool(name) ? [tool(name)!.spec] : []));
  let last = "";
  for (let step = 0; step < agent.steps; step++) {
    if (t.signal.aborted) throw new Error("stopped");
    if (++run.calls > MAX_CALLS_PER_TURN) {
      emit({ type: "notice", text: "This is taking a great many steps, so the assistant has stopped here. Say what to do next and it will carry on." });
      return last || "Stopped: too many steps in one go.";
    }
    // The words go to the screen as they are written. They are not stored: the finished text is, once the step is done.
    const s = await llm.step(conv, { system: promptOf(agent), tools: specs, signal: t.signal, onText: (delta) => t.send(isLead ? { type: "delta", text: delta } : { type: "delta", agent: agent.id, text: delta }) });
    countUsage(t.team, s.tokens);
    if (s.text) {
      last = s.text;
      if (isLead) emit({ type: "text", text: s.text });
      else if (s.calls.length) emit({ type: "note", agent: agent.id, text: s.text });
    }
    if (isLead && s.tokens.in > 150_000) emit({ type: "notice", text: "This conversation has become very long. Start a new one soon: it will be quicker and the assistant will keep track better." });
    if (s.stopped === "refused") {
      if (isLead) emit({ type: "notice", text: "The assistant declined to go on with that." });
      return last || "Declined.";
    }
    if (!s.calls.length) {
      if (isLead) saveChat(t.chat);
      return last;
    }

    // Every call is answered, in one go, even when the turn is being stopped: the model's own record must stay whole.
    const results: { id: string; content: string; failed?: boolean }[] = [];
    for (const call of s.calls) {
      if (s.stopped === "cut_short") results.push({ id: call.id, content: "Not done: your reply was cut off before this was complete. Ask again, more briefly.", failed: true });
      else if (t.signal.aborted) results.push({ id: call.id, content: "Not done: the person stopped the assistant.", failed: true });
      else if (call.name === "delegate" && isLead) results.push(await handOver(run, call));
      else results.push(await carryOut(run, agent.id, call, false));
    }
    llm.results(conv, results);
    if (isLead) saveChat(t.chat);
  }
  if (isLead) emit({ type: "notice", text: "The assistant stopped after many steps. Say what to do next and it will carry on." });
  return last || "Stopped after many steps without finishing.";
}

/** The lead hands a piece of work to a specialist, who starts from the brief alone. */
async function handOver(run: Run, call: ToolCall): Promise<{ id: string; content: string; failed?: boolean }> {
  const { llm, emit } = run;
  const to = AGENTS[String(call.input.to)];
  const brief = String(call.input.brief ?? "").trim();
  if (!to || to.id === "lead") return { id: call.id, content: `There is no specialist called "${String(call.input.to)}". They are: ${SPECIALISTS.map((s) => s.id).join(", ")}.`, failed: true };
  if (!brief) return { id: call.id, content: "The brief is empty. Say what the specialist should do.", failed: true };
  emit({ type: "agent_start", agent: to.id, name: to.name, brief });
  const conv = llm.start();
  llm.say(conv, brief);
  let report: string;
  try {
    report = await work(run, to, conv, false);
  } catch (e) {
    if (run.t.signal.aborted || e instanceof AssistantError) {
      emit({ type: "agent_end", agent: to.id, report: "" });
      throw e;
    }
    console.error("assistant:", e);
    report = "The specialist ran into a problem inside the sandbox and could not finish.";
  }
  emit({ type: "agent_end", agent: to.id, report });
  return { id: call.id, content: report || "(The specialist finished without a report.)" };
}

/** Uses one tool. If it needs the person's say-so first, asks them instead and tells the model to wait. */
async function carryOut(run: Run, agentId: string, call: ToolCall, approved: boolean): Promise<{ id: string; content: string; failed?: boolean }> {
  const { t, ctx, emit } = run;
  const agent = AGENTS[agentId];
  const it = agent?.tools.includes(call.name) ? tool(call.name) : undefined;
  if (!it) return { id: call.id, content: `You have no tool called "${call.name}".`, failed: true };
  const input = call.input ?? {};
  const eventId = approved ? `${call.id}:done` : call.id;
  let label = call.name;
  let shown = false;
  const show = () => {
    if (!shown) emit({ type: "tool", agent: agentId, id: eventId, label });
    shown = true;
  };
  try {
    label = it.label(input);
    if (!approved) {
      const ask = it.askFirst?.(ctx, input);
      if (ask) {
        const p: Pending = { id: `ask_${randomUUID().replace(/-/g, "").slice(0, 12)}`, agent: agentId, tool: call.name, input, summary: ask };
        t.chat.pending.push(p);
        show();
        emit({ type: "tool_result", agent: agentId, id: eventId, ok: false, waiting: true, summary: "Waiting for approval" });
        emit({ type: "confirm", id: p.id, summary: ask });
        return { id: call.id, content: `NOT DONE. This needs the person's approval, and they have now been asked: "${ask}" Do not try it again or look for another way. Stop here and say that you are waiting for their answer.` };
      }
    }
    show();
    const result = await it.run(ctx, input);
    const content = asText(result);
    const said = result && typeof result === "object" && typeof (result as { message?: unknown }).message === "string" ? (result as { message: string }).message : undefined;
    const refused = result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : undefined;
    emit({ type: "tool_result", agent: agentId, id: eventId, ok: !refused, summary: (refused ?? it.tell?.(result) ?? said ?? "Done").slice(0, 240) });
    return { id: call.id, content, failed: !!refused };
  } catch (e) {
    const known = e instanceof SimError || e instanceof ConfigError;
    if (!known) console.error("assistant tool:", call.name, e);
    const why = e instanceof ConfigError ? `Those settings are not valid: ${JSON.stringify(e.errors).slice(0, 800)}` : known ? (e as Error).message : `Something went wrong inside the sandbox: ${(e as Error).message}`;
    show();
    emit({ type: "tool_result", agent: agentId, id: eventId, ok: false, summary: why.slice(0, 240) });
    return { id: call.id, content: `Not done. ${why}`, failed: true };
  }
}
