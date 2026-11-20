import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-assistant-test-"));
process.env.SANDBOX_TEAMS = "2";

const { resetWorld, getWorld } = await import("../src/engine/worlds");
const { resolveSystem, SYSTEM_PATHS } = await import("../src/server/systems");
const { CATALOGUE } = await import("../src/server/assistant/catalogue");
const { AGENTS } = await import("../src/server/assistant/agents");
const { useLlm } = await import("../src/server/assistant/llm");
const { runTurn } = await import("../src/server/assistant/run");
const store = await import("../src/server/assistant/store");
const { tool, toolNames, asText } = await import("../src/server/assistant/tools");
const { count } = await import("../src/engine/db");
const { walletByMsisdn } = await import("../src/engine/ledger");
type Llm = import("../src/server/assistant/llm").Llm;
type Step = import("../src/server/assistant/llm").Step;
type ChatEvent = import("../src/server/assistant/store").ChatEvent;

/**
 * A stand-in for the model that answers from a script, so these tests need no AI service. Each agent's
 * conversation is a list of plain entries; the script decides the next step from what has been said so far.
 */
type Entry = { said?: string; step?: Step; results?: { id: string; content: string; failed?: boolean }[] };
type Script = (system: string, entries: Entry[]) => Partial<Step>;
let script: Script = () => ({ text: "Hello." });
let n = 0;
const fake: Llm = {
  provider: "openai",
  model: "scripted",
  start: () => ({ provider: "openai", model: "scripted", messages: [] }),
  say: (c, text) => void c.messages.push({ said: text }),
  async step(c, o) {
    const s: Step = { text: "", calls: [], tokens: { in: 10, out: 5 }, ...script(o.system, c.messages as Entry[]) };
    c.messages.push({ step: s });
    return s;
  },
  results: (c, results) => void c.messages.push({ results }),
};
const call = (name: string, input: Record<string, unknown>) => ({ id: `call_${++n}`, name, input });
const isLead = (system: string) => system.includes("you lead a small group of specialists");
const lastResults = (entries: Entry[]) => [...entries].reverse().find((e) => e.results)?.results ?? [];
const stepsSoFar = (entries: Entry[]) => entries.filter((e) => e.step).length;

async function turn(team: string, chatId: string | undefined, input: { text?: string; approve?: string; decline?: string }) {
  const chat = chatId ? store.getChat(team, chatId)! : store.newChat(team, input.text ?? "test");
  const events: ChatEvent[] = [];
  await runTurn({ team, chat, origin: "http://127.0.0.1:1", signal: new AbortController().signal, send: (e) => events.push(e) }, input);
  return { chat: store.getChat(team, chat.id)!, events };
}
const of = (events: ChatEvent[], type: string) => events.filter((e) => e.type === type);

beforeAll(async () => {
  useLlm(fake);
  await resetWorld("team-01");
  await resetWorld("team-02");
});

describe("what the assistant knows it can do", () => {
  it("lists every action of every console, and nothing that is not there", () => {
    // One console of each kind stands for the others of its kind.
    for (const [path, info] of Object.entries(CATALOGUE)) {
      const system = resolveSystem(path.split("/"));
      const real = [...Object.keys(system.actions), ...Object.keys(system.staged ?? {})].sort();
      expect({ path, actions: Object.keys(info.actions).sort() }).toEqual({ path, actions: real });
    }
    // Every console the API offers is covered, apart from the phone, which has tools of its own.
    const kinds = new Set(Object.keys(CATALOGUE).map((p) => p.split("/")[0]));
    for (const p of SYSTEM_PATHS) if (p !== "phone") expect(kinds.has(p.split("/")[0])).toBe(true);
  });

  it("gives each specialist only tools that exist, and the lead a way to hand work over", () => {
    for (const a of Object.values(AGENTS)) for (const t of a.tools) expect(t === "delegate" || !!tool(t), `${a.id} has ${t}`).toBe(true);
    expect(AGENTS.lead.tools).toContain("delegate");
    for (const a of Object.values(AGENTS)) if (a.id !== "lead") expect(a.tools).not.toContain("delegate");
    // Nothing that wipes or replaces a world is in a specialist's hands.
    for (const a of Object.values(AGENTS)) if (a.id !== "lead") for (const t of ["wipe_world", "roll_back", "load_simulated_country"]) expect(a.tools).not.toContain(t);
    expect(toolNames().length).toBeGreaterThan(20);
  });
});

describe("a conversation with the assistant", () => {
  let chatId = "";
  let ama = { number: "", pin: "" };
  let kofi = { number: "", pin: "" };

  it("does what it is asked with its tools and says what happened", async () => {
    script = (_s, entries) => {
      if (stepsSoFar(entries) === 0) return { calls: [call("create_test_customer", { network: "mtn" }), call("create_test_customer", { network: "mtn", amount: 50 })] };
      return { text: `Both are ready. ${lastResults(entries).map((r) => (JSON.parse(r.content) as { message: string }).message).join(" ")}` };
    };
    const { chat, events } = await turn("team-01", undefined, { text: "Make two customers on MTN." });
    chatId = chat.id;
    expect(of(events, "user")[0]).toMatchObject({ text: "Make two customers on MTN." });
    expect(of(events, "tool").map((e) => e.label)).toEqual(["Creating a test customer on MTN", "Creating a test customer on MTN"]);
    expect(of(events, "tool_result").every((e) => e.ok === true)).toBe(true);
    const said = String(of(events, "text")[0].text);
    const found = [...said.matchAll(/(0\d{9}) on MTN, wallet PIN (\d{4})/g)];
    expect(found).toHaveLength(2);
    [ama, kofi] = found.map((m) => ({ number: m[1], pin: m[2] }));
    expect(walletByMsisdn(getWorld("team-01"), ama.number)).toMatchObject({ pin: ama.pin, balance: 50000 });
    expect(walletByMsisdn(getWorld("team-01"), kofi.number)!.balance).toBe(5000);
    expect(events[events.length - 1]).toMatchObject({ type: "done", waiting: 0 });
    // What was shown is kept, so the conversation is there after a reload; and the use is counted.
    expect(store.chatEvents(chat.id).map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(store.usageToday("team-01").calls).toBe(2);
  });

  it("hands work to a specialist, who starts from the brief alone and reports back", async () => {
    let brief = "";
    script = (system, entries) => {
      if (isLead(system)) {
        const mine = entries.filter((e) => e.step).slice(1); // steps of this turn come after the first turn's two
        if (!lastResults(entries).some((r) => r.content.includes("sent to"))) return { calls: [call("delegate", { to: "operator", brief: `On ${ama.number} dial *170# and send GHS 20 to ${kofi.number}. The PIN is ${ama.pin}.` })] };
        return { text: `Done (${mine.length} steps). ${lastResults(entries)[0].content}` };
      }
      // The operator: knows only the brief.
      brief = entries[0].said ?? "";
      if (stepsSoFar(entries) === 0) return { text: "Sending it now.", calls: [call("dial_ussd", { number: ama.number, inputs: ["*170#", "1", "1", kofi.number, kofi.number, "20", "lunch", ama.pin] })] };
      const screens = (JSON.parse(lastResults(entries)[0].content) as { screens: { typed: string; screen: string }[] }).screens;
      return { text: `${screens[screens.length - 1].screen} PIN typed shown as ${screens[screens.length - 1].typed}.` };
    };
    const { events } = await turn("team-01", chatId, { text: "Send 20 cedis from the first to the second." });
    expect(of(events, "agent_start")[0]).toMatchObject({ agent: "operator", name: "Operator" });
    expect(brief).toContain(`send GHS 20 to ${kofi.number}`);
    expect(of(events, "note")[0]).toMatchObject({ agent: "operator", text: "Sending it now." });
    expect(of(events, "tool")[0]).toMatchObject({ agent: "operator", label: `Dialling *170# on ${ama.number} and typing 7 replies` });
    expect(String(of(events, "tool_result")[0].summary)).toMatch(/GHS 20.00 sent to/);
    expect(String(of(events, "agent_end")[0].report)).toMatch(/GHS 20.00 sent to/);
    // The PIN the specialist typed is not echoed back into the conversation.
    expect(String(of(events, "agent_end")[0].report)).toContain("PIN typed shown as (PIN)");
    expect(String(of(events, "text")[0].text)).toMatch(/GHS 20.00 sent to/);
    expect(walletByMsisdn(getWorld("team-01"), kofi.number)!.balance).toBe(7000);
  });

  it("asks before anything that cannot be put back, and does exactly what was approved", async () => {
    script = (_s, entries) => {
      const last = entries[entries.length - 1];
      if (last.said?.startsWith("[I declined")) return { text: "Left as it is." };
      if (last.said?.startsWith("[I approved")) return { text: "It is done." };
      if (last.results) return { text: "I am waiting for your answer." };
      return { calls: [call("wipe_world", {})] };
    };
    let r = await turn("team-01", chatId, { text: "Wipe my world." });
    const ask = of(r.events, "confirm")[0];
    expect(String(ask.summary)).toMatch(/Wipe the whole world back to an empty country/);
    expect(of(r.events, "tool_result")[0]).toMatchObject({ ok: false, waiting: true });
    expect(r.events[r.events.length - 1]).toMatchObject({ type: "done", waiting: 1 });
    // Nothing has happened yet, and the model was told to stop and wait.
    expect(count(getWorld("team-01").db, "SELECT COUNT(*) AS n FROM persons")).toBe(2);
    const told = (r.chat.conversation!.messages as Entry[]).findLast((e) => e.results)!.results![0].content;
    expect(told).toMatch(/NOT DONE\. This needs the person's approval/);

    // Declined: nothing is done, and it is no longer waiting.
    r = await turn("team-01", chatId, { decline: String(ask.id) });
    expect(of(r.events, "declined")).toHaveLength(1);
    expect(count(getWorld("team-01").db, "SELECT COUNT(*) AS n FROM persons")).toBe(2);
    expect(r.chat.pending).toHaveLength(0);
    r = await turn("team-01", chatId, { approve: String(ask.id) });
    expect(of(r.events, "error")[0].message).toMatch(/no longer waiting/);

    // Asked again and approved: the sandbox carries it out itself, then tells the model it happened.
    r = await turn("team-01", chatId, { text: "Wipe it after all." });
    const again = of(r.events, "confirm")[0];
    r = await turn("team-01", chatId, { approve: String(again.id) });
    expect(of(r.events, "approved")).toHaveLength(1);
    expect(of(r.events, "tool_result")[0]).toMatchObject({ ok: true });
    expect(count(getWorld("team-01").db, "SELECT COUNT(*) AS n FROM persons")).toBe(0);
    expect((r.chat.conversation!.messages as Entry[]).some((e) => e.said?.startsWith("[I approved this: Wipe the whole world"))).toBe(true);
    // The conversation outlived the world it wiped.
    expect(store.chatEvents(chatId).filter((e) => e.type === "user")).toHaveLength(4);
  });

  it("tells the model plainly when something cannot be done, and keeps going", async () => {
    const answers: Record<string, string[]> = {};
    const jobs: Record<string, ReturnType<typeof call>[]> = {
      builder: [call("act", { system: "telco/mtn", action: "add_sims", fields: { count: 999 } }), call("act", { system: "telco/mtn", action: "no_such_thing" }), call("act", { system: "nowhere", action: "x" }), call("lookup", { table: "wallets", columns: ["pin"] })],
      analyst: [call("summarise", { table: "secrets" })],
      operator: [call("dial_ussd", { number: "0240000000", inputs: ["*170#"] })],
      integrator: [call("fraud_run", { kinds: "all" })], // the fraud simulator needs people to play the victims
    };
    script = (system, entries) => {
      if (isLead(system)) return entries[entries.length - 1].results ? { text: "Some of that could not be done." } : { calls: Object.keys(jobs).map((to) => call("delegate", { to, brief: "Try it." })) };
      const who = Object.keys(jobs).find((id) => system.includes(`You are the ${id}.`))!;
      if (stepsSoFar(entries) === 0) return { calls: jobs[who] };
      answers[who] = lastResults(entries).map((r) => r.content);
      return { text: "Could not." };
    };
    const { events } = await turn("team-01", chatId, { text: "Try some things that will not work." });
    expect(of(events, "tool_result").filter((e) => e.agent !== "operator").every((e) => e.ok === false)).toBe(true);
    expect(answers.builder[0]).toMatch(/Not done\. Choose between 1 and 200 SIMs/);
    expect(answers.builder[1]).toMatch(/telco\/mtn has no action "no_such_thing"\. It has: add_sims/);
    expect(answers.builder[2]).toMatch(/There is no system called "nowhere"/);
    expect(answers.builder[3]).toMatch(/There is no column "pin" in wallets/);
    expect(answers.analyst[0]).toMatch(/There is no table "secrets" to read/);
    // A phone that is not registered is not a failure of the tool: the screen says so, as it would to a person.
    expect(answers.operator[0]).toMatch(/SIM not registered/);
    expect(answers.integrator[0]).toMatch(/Not done\. The fraud simulator needs people to act as victims/);
    expect(of(events, "agent_end")).toHaveLength(4);
    expect(of(events, "text")[0].text).toBe("Some of that could not be done.");
  });

  it("only lets a specialist use its own tools, and never shows a wallet PIN", async () => {
    const answers: string[] = [];
    script = (system, entries) => {
      if (isLead(system)) return lastResults(entries).length && entries[entries.length - 1].results ? { text: "ok" } : { calls: [call("delegate", { to: "analyst", brief: "Look at the wallets." }), call("delegate", { to: "nobody", brief: "x" })] };
      if (stepsSoFar(entries) === 0) return { calls: [call("create_test_customer", { network: "at" }), call("act", { system: "telco/mtn", action: "add_sims", fields: { count: 5 } })] };
      if (stepsSoFar(entries) === 1) {
        answers.push(...lastResults(entries).map((r) => r.content));
        return { calls: [call("lookup", { table: "wallets" }), call("read_console", { system: "telco/mtn", section: "wallets" })] };
      }
      answers.push(...lastResults(entries).map((r) => r.content));
      return { text: "The analyst only reads." };
    };
    const w = getWorld("team-01");
    await resolveSystem(["hub"]).staged!.test_customer(w, { network: "mtn" });
    const { events } = await turn("team-01", chatId, { text: "Have the analyst change something." });
    expect(answers[0]).toBe('You have no tool called "create_test_customer".');
    expect(answers[1]).toBe('You have no tool called "act".');
    expect(count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = 'mtn' AND status = 'in_stock'")).toBeLessThan(10);
    const pin = (w.db.prepare("SELECT pin FROM wallets LIMIT 1").get() as { pin: string }).pin;
    expect(answers[2]).toContain('"balance":500');
    expect(answers[2]).not.toContain(`"pin"`);
    expect(answers[3]).not.toContain(`"pin"`);
    expect(asText({ wallet: { pin, balance: 5 } })).toBe('{"wallet":{"balance":5}}');
    // A specialist that does not exist is an answer for the lead, not a failure of the turn.
    expect(of(events, "agent_start")).toHaveLength(1);
    expect(of(events, "error")).toHaveLength(0);
  });

  it("searches and adds up the stored data in cedis and dates", async () => {
    const w = getWorld("team-01");
    const ctx = { team: "team-01", world: () => getWorld("team-01"), origin: "" };
    const made = (await resolveSystem(["hub"]).staged!.test_customer(w, { network: "telecel", amount: 120 })) as { customer: { number: string } };
    const found = (await tool("lookup")!.run(ctx, { table: "wallets", where: [{ column: "balance", op: "=", value: 120 }] })) as { rows: Record<string, unknown>[]; matching: number };
    expect(found.matching).toBe(1);
    expect(found.rows[0]).toMatchObject({ msisdn: made.customer.number, balance: 120, kyc_tier: "medium" });
    expect(String(found.rows[0].created_at)).toMatch(/^\d{4}-\d\d-\d\dT/);
    const totals = (await tool("summarise")!.run(ctx, { table: "txns", groupBy: ["type"], measure: "sum:amount", where: [{ column: "status", value: "success" }, { column: "created_at", op: ">=", value: "2020-01-01" }] })) as { type: string; result: number }[];
    expect(totals.find((t) => t.type === "bank_to_wallet")!.result).toBe(620); // GHS 500 and GHS 120 paid in from the bank
    await expect(tool("lookup")!.run(ctx, { table: "wallets", where: [{ column: "balance; DROP TABLE wallets", value: 1 }] })).rejects.toThrow(/There is no column/);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM wallets")).toBe(2);
  });

  it("keeps one team's conversations to that team, and stops at the day's limit", async () => {
    expect(store.getChat("team-02", chatId)).toBeUndefined();
    expect(store.listChats("team-02")).toHaveLength(0);
    expect(store.listChats("team-01")[0].id).toBe(chatId);
    process.env.ASSISTANT_DAILY_CALLS = "1";
    try {
      const { events } = await turn("team-01", chatId, { text: "One more thing." });
      expect(of(events, "error")[0].message).toMatch(/reached today's limit/);
      expect(of(events, "user")).toHaveLength(0);
    } finally {
      delete process.env.ASSISTANT_DAILY_CALLS;
    }
  });
});
