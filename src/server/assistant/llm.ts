import Anthropic from "@anthropic-ai/sdk";

/**
 * The model behind the assistant. Two services are supported, chosen by which key the server has:
 * Claude (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY). ASSISTANT_PROVIDER picks one when both are set,
 * and ASSISTANT_MODEL names a model other than the default.
 *
 * Each service keeps a conversation in its own shape, and wants it handed back exactly as it gave it
 * (the model's own turns carry state that must not be edited). So a conversation is stored as that
 * service's own list of messages, only ever added to, and everything else talks to it through three
 * moves: add what the user said, take one step (the model answers and may ask for tools), add the
 * tools' results.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Step {
  text: string;
  calls: ToolCall[];
  /**
   * Set when the model stopped for a reason other than finishing or asking for tools. A reply that was cut
   * short may hold half a tool call: its calls must be answered (the service insists) but not carried out.
   */
  stopped?: "refused" | "cut_short";
  tokens: { in: number; out: number };
}

export interface Conversation {
  provider: string;
  model: string;
  /** The service's own messages, in order. Added to, never edited. */
  messages: unknown[];
}

export interface Llm {
  provider: "anthropic" | "openai" | "demo";
  model: string;
  start(): Conversation;
  say(c: Conversation, text: string): void;
  /** One step. `onText` is told the model's words as they are written, so the screen can show them coming in. */
  step(c: Conversation, o: { system: string; tools: ToolSpec[]; signal?: AbortSignal; onText?: (delta: string) => void }): Promise<Step>;
  results(c: Conversation, results: { id: string; content: string; failed?: boolean }[]): void;
}

const DEFAULT_MODEL = { anthropic: "claude-opus-5-5", openai: "gpt-6.2-sol" } as const;

/**
 * Which service this server is set up for, if any. ASSISTANT_PROVIDER=demo runs a stand-in that needs no key: it
 * does real work in the world through the real tools, with scripted words, so the assistant can be seen and tried.
 */
export function provider(): "anthropic" | "openai" | "demo" | undefined {
  const has = { anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), openai: !!process.env.OPENAI_API_KEY };
  const asked = process.env.ASSISTANT_PROVIDER;
  if (asked === "demo") return "demo";
  if (asked === "anthropic" || asked === "openai") return has[asked] ? asked : undefined;
  return has.anthropic ? "anthropic" : has.openai ? "openai" : undefined;
}

let standIn: Llm | undefined;
/** For tests: a stand-in that answers from a script instead of calling a service. */
export function useLlm(llm: Llm | undefined) {
  standIn = llm;
}

export function getLlm(): Llm | undefined {
  if (standIn) return standIn;
  const p = provider();
  if (!p) return undefined;
  if (p === "demo") return demo();
  const model = process.env.ASSISTANT_MODEL || DEFAULT_MODEL[p];
  return p === "anthropic" ? claude(model) : openai(model);
}

/** A failure the person using the assistant can do something about, in plain words. */
export class AssistantError extends Error {}

// ---------- Claude ----------

let client: Anthropic | undefined;

function claude(model: string): Llm {
  return {
    provider: "anthropic",
    model,
    start: () => ({ provider: "anthropic", model, messages: [] }),
    say(c, text) {
      (c.messages as Anthropic.Beta.BetaMessageParam[]).push({ role: "user", content: text });
    },
    async step(c, o) {
      client ??= new Anthropic();
      const messages = c.messages as Anthropic.Beta.BetaMessageParam[];
      let res: Anthropic.Beta.BetaMessage;
      try {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 16000,
            // The instructions and the tools are the same on every step, so they are read from cache after the first.
            cache_control: { type: "ephemeral" },
            system: o.system,
            tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool["input_schema"] })),
            messages,
            // If the model declines a request on policy grounds, the same request is tried on a fallback model in the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            ...(process.env.ASSISTANT_EFFORT ? { output_config: { effort: process.env.ASSISTANT_EFFORT as "low" | "medium" | "high" } } : {}),
          },
          { signal: o.signal },
        );
        // The words are passed on as they arrive; the whole message, thinking included, is kept once it is complete.
        if (o.onText) stream.on("text", (delta) => o.onText!(delta));
        res = await stream.finalMessage();
      } catch (e) {
        // Most specific first: what can be retried later is told apart from what needs fixing.
        if (e instanceof Anthropic.AuthenticationError) throw new AssistantError("The assistant's key for Claude was not accepted. The organisers need to check ANTHROPIC_API_KEY on the server.");
        if (e instanceof Anthropic.RateLimitError) throw new AssistantError("The assistant is being used a lot right now. Please try again in a minute.");
        if (e instanceof Anthropic.APIConnectionError) throw new AssistantError("The assistant could not reach Claude. Please try again.");
        if (e instanceof Anthropic.BadRequestError) throw new AssistantError(`Claude did not accept the request: ${e.message}`);
        if (e instanceof Anthropic.APIError) throw new AssistantError(`Claude had a problem (${e.status ?? "no status"}). Please try again.`);
        throw e;
      }
      // Handed back exactly as it came, thinking included.
      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      const calls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
      return {
        text,
        calls,
        stopped: res.stop_reason === "refusal" ? "refused" : res.stop_reason === "max_tokens" ? "cut_short" : undefined,
        tokens: { in: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), out: res.usage.output_tokens },
      };
    },
    results(c, results) {
      // Every result of one step goes back in a single message.
      (c.messages as Anthropic.Beta.BetaMessageParam[]).push({ role: "user", content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.failed || undefined })) });
    },
  };
}

// ---------- OpenAI ----------

interface OpenAiItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
}

function openai(model: string): Llm {
  return {
    provider: "openai",
    model,
    start: () => ({ provider: "openai", model, messages: [] }),
    say(c, text) {
      c.messages.push({ role: "user", content: text });
    },
    async step(c, o) {
      const body = JSON.stringify({
        model,
        instructions: o.system,
        input: c.messages,
        tools: o.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        // Nothing is kept at OpenAI: the whole conversation is sent each time, with the model's own reasoning handed back to it.
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
      });
      let res: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" }, body, signal: o.signal });
        } catch (e) {
          if (o.signal?.aborted) throw e;
          if (attempt >= 2) throw new AssistantError("The assistant could not reach OpenAI. Please try again.");
        }
        if (res && (res.ok || (res.status < 500 && res.status !== 429))) break;
        if (attempt >= 2) break;
        await new Promise((done) => setTimeout(done, 800 * (attempt + 1)));
      }
      if (!res) throw new AssistantError("The assistant could not reach OpenAI. Please try again.");
      type Done = { output?: OpenAiItem[]; error?: { message?: string }; status?: string; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
      let j: Done = {};
      if (!res.ok || !res.body) j = (await res.json().catch(() => ({}))) as Done;
      else {
        // A stream of events: the words as they are written, then the whole response at the end.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let waiting = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          waiting += decoder.decode(value, { stream: true });
          const parts = waiting.split("\n\n");
          waiting = parts.pop() ?? "";
          for (const part of parts) {
            const data = part.split("\n").find((l) => l.startsWith("data: "));
            if (!data) continue;
            let e: { type?: string; delta?: string; response?: Done; message?: string };
            try {
              e = JSON.parse(data.slice(6));
            } catch {
              continue;
            }
            if (e.type === "response.output_text.delta" && e.delta) o.onText?.(e.delta);
            else if (e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed") j = e.response ?? {};
            else if (e.type === "error") j = { error: { message: e.message } };
          }
        }
      }
      if (!res.ok || !j.output) {
        if (res.status === 401) throw new AssistantError("The assistant's key for OpenAI was not accepted. The organisers need to check OPENAI_API_KEY on the server.");
        if (res.status === 429) throw new AssistantError("The assistant is being used a lot right now. Please try again in a minute.");
        throw new AssistantError(`OpenAI did not accept the request: ${j.error?.message ?? `status ${res.status}`}`);
      }
      c.messages.push(...j.output);
      const text = j.output
        .filter((i) => i.type === "message")
        .flatMap((i) => (i.content as { type: string; text?: string; refusal?: string }[]).map((p) => p.text ?? p.refusal ?? ""))
        .join("\n")
        .trim();
      const refused = j.output.some((i) => i.type === "message" && (i.content as { type: string }[]).some((p) => p.type === "refusal"));
      const calls = j.output.flatMap((i) => {
        if (i.type !== "function_call") return [];
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(i.arguments || "{}");
        } catch {
          input = { _unreadable: i.arguments };
        }
        return [{ id: String(i.call_id), name: String(i.name), input }];
      });
      return { text, calls, stopped: refused ? "refused" : j.status === "incomplete" ? "cut_short" : undefined, tokens: { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 } };
    },
    results(c, results) {
      for (const r of results) c.messages.push({ type: "function_call_output", call_id: r.id, output: r.content });
    },
  };
}

// ---------- demo: no key needed ----------

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Writes text out a few characters at a time, as a model would. */
async function typeOut(text: string, onText: ((d: string) => void) | undefined, signal?: AbortSignal) {
  if (!onText) return;
  for (let i = 0; i < text.length; i += 4) {
    if (signal?.aborted) return;
    onText(text.slice(i, i + 4));
    await pause(12);
  }
}

type DemoMessage = { role: "user" | "assistant" | "tool"; content: string; calls?: ToolCall[] };

/**
 * A stand-in for a model, for trying the assistant without a key (ASSISTANT_PROVIDER=demo). The lead hands the
 * question to the analyst, who looks at the world with the real tool and reports; the lead then answers. The
 * words are scripted, but the work and the numbers are real.
 */
function demo(): Llm {
  return {
    provider: "demo",
    model: "demo",
    start: () => ({ provider: "demo", model: "demo", messages: [] }),
    say(c, text) {
      (c.messages as DemoMessage[]).push({ role: "user", content: text });
    },
    async step(c, o) {
      const messages = c.messages as DemoMessage[];
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const sinceUser = messages.length - 1 - messages.map((m) => m.role).lastIndexOf("user");
      const lastTool = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
      const isLead = o.tools.some((t) => t.name === "delegate");
      const can = (name: string) => o.tools.some((t) => t.name === name);
      let text = "";
      let calls: ToolCall[] = [];
      await pause(350);
      if (isLead && sinceUser === 0) {
        text = "Let me check that for you. I'll ask the **analyst** to look at your world first.";
        calls = [{ id: `demo_${Date.now()}`, name: "delegate", input: { to: "analyst", brief: `Look at the team's world and report what is in it, in a few lines. The team asked: "${lastUser.slice(0, 200)}"` } }];
      } else if (isLead) {
        const report = lastTool.replace(/^\s*\{[\s\S]*$/, "").trim() || lastTool.slice(0, 600);
        text = `Here is what I found.\n\n${report}\n\n**Next steps you could try**\n- Create a test customer and send money from their phone.\n- Plug a fraud check into a network from the **Developer** console.\n- Run the **Fraud console** to see what gets through.\n\n_This is the demo assistant: the work and numbers are real, the words are scripted. Add an API key for the real one._`;
      } else if (sinceUser === 0 && can("world_overview")) {
        text = "Reading the world overview.";
        calls = [{ id: `demo_${Date.now()}`, name: "world_overview", input: {} }];
      } else {
        let facts = lastTool;
        try {
          const j = JSON.parse(lastTool) as { counts?: Record<string, number> };
          if (j.counts) facts = Object.entries(j.counts).filter(([, n]) => typeof n === "number").slice(0, 8).map(([k, n]) => `| ${k.replace(/([A-Z])/g, " $1").toLowerCase()} | ${n} |`).join("\n");
          if (j.counts) facts = `| What | How many |\n|---|---|\n${facts}`;
        } catch {
          facts = lastTool.slice(0, 500);
        }
        text = facts;
      }
      await typeOut(text, o.onText, o.signal);
      messages.push({ role: "assistant", content: text, calls });
      return { text, calls, tokens: { in: 0, out: 0 } };
    },
    results(c, results) {
      for (const r of results) (c.messages as DemoMessage[]).push({ role: "tool", content: r.content });
    },
  };
}
