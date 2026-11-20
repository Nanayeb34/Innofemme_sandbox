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
  provider: "anthropic" | "openai";
  model: string;
  start(): Conversation;
  say(c: Conversation, text: string): void;
  step(c: Conversation, o: { system: string; tools: ToolSpec[]; signal?: AbortSignal }): Promise<Step>;
  results(c: Conversation, results: { id: string; content: string; failed?: boolean }[]): void;
}

const DEFAULT_MODEL = { anthropic: "claude-opus-5-5", openai: "gpt-6.2-sol" } as const;

/** Which service this server is set up for, if any. */
export function provider(): "anthropic" | "openai" | undefined {
  const has = { anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), openai: !!process.env.OPENAI_API_KEY };
  const asked = process.env.ASSISTANT_PROVIDER;
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
        res = await client.beta.messages.create(
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
      const j = (await res.json().catch(() => ({}))) as { output?: OpenAiItem[]; error?: { message?: string }; status?: string; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
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
