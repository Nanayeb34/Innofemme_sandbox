import { listBridges } from "@/engine/bridge";
import { applyPatch, diffJson, getConfig, setConfig, undoChange, type PatchOp } from "@/engine/config/store";
import { SURFACE_NAMES } from "@/engine/config/schemas";
import { count } from "@/engine/db";
import { POINTS, locked } from "@/engine/integrations";
import { dial } from "@/engine/ussdapps";
import { SimError, normalizeMsisdn } from "@/engine/util";
import { getWorld, listSnapshots, loadSimulated, resetWorld, restoreSnapshot, simulatedSummary, snapshotWorld } from "@/engine/worlds";
import { withLock, type World } from "@/engine/world";
import { resolveSystem } from "@/server/systems";
import { CATALOGUE, describeActions } from "./catalogue";
import type { ToolSpec } from "./llm";

/**
 * What the assistant can do. Each tool works on one team's world and nothing else, and goes through the same
 * doors a person at the consoles goes through: the same actions, the same checks, the same plugged-in APIs.
 * Nothing here reaches another team, the server, or the internet.
 */

export interface ToolContext {
  team: string;
  /** The team's world as it is now. Asked for each time, because a world can be replaced during a conversation. */
  world(): World;
  /** This server's own address, for reading its documentation. */
  origin: string;
  signal?: AbortSignal;
}

export interface Tool {
  spec: ToolSpec;
  /** One line saying what a call does, shown to the user while it runs. */
  label(input: Record<string, unknown>): string;
  /** One line saying how a call went, shown to the user when it is done. Left out, the answer's own message is used. */
  tell?(result: unknown): string | undefined;
  /** If this call needs the user's say-so first, what to ask them. */
  askFirst?(ctx: ToolContext, input: Record<string, unknown>): string | undefined;
  run(ctx: ToolContext, input: Record<string, unknown>): unknown | Promise<unknown>;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const N = (description: string) => ({ type: "number", description });

const systemPath = (v: unknown): string[] => {
  const path = str(v).replace(/^\/+|\/+$/g, "");
  if (!CATALOGUE[path] && path !== "phone") throw new SimError(`There is no system called "${path}". The systems are: ${Object.keys(CATALOGUE).join(", ")}, phone.`);
  return path.split("/");
};

/** Never handed to the model, wherever they turn up: a wallet PIN is not shown anywhere in the sandbox. */
const HIDDEN = new Set(["pin", "puk"]);
const scrub = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !HIDDEN.has(k)).map(([k, x]) => [k, scrub(x)])) : v;

/** A console's view is large. This gives its outline, so one part can then be asked for. */
function outline(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return `${v.length} row(s)${v.length && v[0] && typeof v[0] === "object" ? ` with ${Object.keys(v[0] as object).join(", ")}` : ""}`;
  if (v && typeof v === "object") {
    const small = JSON.stringify(v);
    if (depth > 0 && small.length <= 400) return v;
    if (depth > 1) return `{ ${Object.keys(v).join(", ")} }`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, outline(x, depth + 1)]));
  }
  return v;
}

const at = (v: unknown, path: string): unknown => path.split(".").filter(Boolean).reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), v);

// ---------- looking things up in the stored data ----------

/** The tables that can be read, and the columns kept back from each. */
const TABLES: Record<string, { what: string; hide?: string[] }> = {
  persons: { what: "everyone with a Ghana Card" },
  sims: { what: "every SIM: its number, network, status, owner, when it was registered and last replaced", hide: ["puk"] },
  sim_events: { what: "what has happened to each number: registered, swapped, blocked, PIN reset" },
  sim_agents: { what: "SIM registration points" },
  wallets: { what: "mobile money wallets: owner, KYC tier, status, balance", hide: ["pin"] },
  momo_agents: { what: "mobile money agents: agent number, shop, till cash, commission" },
  merchants: { what: "merchants and their till numbers" },
  bank_accounts: { what: "bank accounts" },
  txns: { what: "every transaction: type, channel, both sides, amount, fee, status, reason, when" },
  dataset: { what: "for the simulated country: which transactions are fraud (is_fraud), of which kind (scenario), in which case (case_id) and role" },
  calls: { what: "voice calls: from, to, status, when, how long" },
  sms_log: { what: "texts sent: sender, recipient, body, whether delivered" },
  tickets: { what: "customer care complaints and disputes" },
  approvals: { what: "requests waiting for, or answered by, a customer: cash-outs, payment requests, claims" },
  bill_payments: { what: "bills paid from wallets" },
  settlements: { what: "settlement runs at the national switch" },
  nia_log: { what: "identity checks institutions have made at NIA" },
  audit: { what: "what each institution's staff did, in order" },
  integrations: { what: "APIs plugged into institutions' steps" },
  integration_calls: { what: "each question asked of a plugged-in API and what it answered" },
  fraud_runs: { what: "runs of the fraud simulator" },
  fraud_incidents: { what: "each incident played by the fraud simulator and how it ended" },
  api_clients: { what: "companies given API access", hide: ["secret"] },
};
const MONEY = new Set(["amount", "fee", "commission", "balance", "cash", "held", "returned", "at_risk", "lost"]);
const isTime = (c: string) => c === "at" || c.endsWith("_at");
const OPS: Record<string, string> = { "=": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=", like: "LIKE", in: "IN" };

function columnsOf(w: World, table: string): string[] {
  if (!TABLES[table]) throw new SimError(`There is no table "${table}" to read. The tables are: ${Object.keys(TABLES).join(", ")}.`);
  const hide = TABLES[table].hide ?? [];
  return (w.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).filter((c) => !hide.includes(c));
}

/** Turns the conditions the model gave into SQL, with every value passed separately and every column checked. */
function conditions(cols: string[], where: unknown): { sql: string; args: (string | number)[] } {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  for (const c of Array.isArray(where) ? (where as Record<string, unknown>[]) : []) {
    const column = str(c.column);
    const op = OPS[str(c.op || "=").toLowerCase()];
    if (!cols.includes(column)) throw new SimError(`There is no column "${column}" here. The columns are: ${cols.join(", ")}.`);
    if (!op) throw new SimError(`"${str(c.op)}" is not a comparison. Use one of: ${Object.keys(OPS).join(", ")}.`);
    const value = (v: unknown): string | number => {
      if (MONEY.has(column) && v !== null && v !== "" && Number.isFinite(Number(v))) return Math.round(Number(v) * 100);
      if (isTime(column) && typeof v === "string" && !/^\d+$/.test(v) && !Number.isNaN(Date.parse(v))) return Date.parse(v);
      return typeof v === "number" ? v : str(v);
    };
    if (op === "IN") {
      const list = (Array.isArray(c.value) ? c.value : [c.value]).slice(0, 50);
      parts.push(`${column} IN (${list.map(() => "?").join(",")})`);
      args.push(...list.map(value));
    } else if (c.value === null) {
      parts.push(op === "!=" ? `${column} IS NOT NULL` : `${column} IS NULL`);
    } else {
      parts.push(`${column} ${op} ?`);
      args.push(value(c.value));
    }
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

/** Rows as the model should read them: money in cedis, times as dates. */
const readable = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === "number" && MONEY.has(k) ? v / 100 : typeof v === "number" && isTime(k) && v > 1e11 ? new Date(v).toISOString() : typeof v === "bigint" ? Number(v) : v]),
  );

const WHERE = {
  type: "array",
  description: 'Conditions that must all hold, for example [{"column":"status","op":"=","value":"failed"},{"column":"amount","op":">","value":1000}]. Money is in cedis. Times can be given as dates (2026-11-20 or 2026-11-20T10:00:00Z).',
  items: obj({ column: S("a column of the table"), op: S("one of =, !=, >, >=, <, <=, like, in"), value: { description: "the value to compare with; a list for in; null for empty" } }, ["column", "value"]),
};

// ---------- the documentation ----------

let docs: { at: number; sections: { id: string; title: string; text: string }[] } | undefined;

async function documentation(origin: string) {
  if (docs && Date.now() - docs.at < 5 * 60_000) return docs.sections;
  const html = await (await fetch(`${origin}/docs`, { signal: AbortSignal.timeout(15_000) })).text();
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
  const sections = [...html.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => {
    const title = decode((m[2].match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? m[1]).replace(/<[^>]+>/g, ""));
    const text = decode(
      m[2]
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<summary[\s\S]*?<\/summary>/g, "")
        .replace(/<\/(p|li|tr|h2|h3|pre|div|ol|ul|table)>|<br\s*\/?>/g, "\n")
        .replace(/<\/t[dh]>/g, " | ")
        .replace(/<[^>]+>/g, ""),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
    return { id: m[1], title, text };
  });
  if (sections.length) docs = { at: Date.now(), sections };
  return sections;
}

// ---------- the tools ----------

const TOOLS: Record<string, Tool> = {
  world_overview: {
    spec: { name: "world_overview", description: "How much is in the team's world right now: people, numbers, wallets, agents, merchants, bank accounts, payments; which steps of building a world are done; whether the simulated country is loaded; the latest fraud run in one line. Start here when you do not know the state of the world.", parameters: obj({}) },
    label: () => "Looking at what is in the world",
    run: (ctx) =>
      withLock(ctx.world(), () => {
        const w = ctx.world();
        const hub = resolveSystem(["hub"]).view(w, new URLSearchParams()) as { counts: unknown; steps: { title: string; done: boolean }[]; fraud: unknown };
        const sim = simulatedSummary(w);
        return { counts: hub.counts, buildingSteps: hub.steps.map((s) => `${s.done ? "done" : "not yet"}: ${s.title}`), simulatedCountry: sim ? `loaded: ${sim.transactions} transactions, ${sim.fraud} of them fraud` : "not loaded", latestFraudRun: hub.fraud ?? "none yet" };
      }),
  },

  list_actions: {
    spec: { name: "list_actions", description: "What can be done at the consoles, with the fields each action takes. Give a system (for example telco/mtn, bank/gcb, sim-agent/telecel, switch) for that console's actions, or nothing for all of them. Read this before using act on a console you have not used yet.", parameters: obj({ system: S("a console's path?") }) },
    label: (i) => (i.system ? `Checking what can be done at ${str(i.system)}` : "Checking what can be done at each console"),
    run: (_ctx, i) => describeActions(str(i.system) || undefined),
  },

  read_console: {
    spec: {
      name: "read_console",
      description:
        "Read what an institution's console shows. Without a section you get an outline: every part of the console, with how many rows each list has and what the rows hold. With a section (for example stats, wallets, txns, plugins, pluginCalls, latest.incidents) you get that part: lists come as rows, which you can narrow with search (text that must appear in a row) and limit. Systems: hub, fraud, nia, telco/{mtn|telecel|at}, care/{…}, sim-agent/{…}, momo-agent/{…}, bank/{bank}, switch, bog, nca, phone. A query can pick what the console looks at: phone takes msisdn; care takes customer (a number) or ticket; sim-agent and momo-agent take agent; nca takes card.",
      parameters: obj({ system: S("the console's path"), section: S("a part of the console, by name; dots go deeper (latest.incidents)?"), search: S("only rows containing this text?"), limit: N("how many rows, up to 40 (default 10)?"), query: { type: "object", description: "what the console should look at, for consoles that take one?", additionalProperties: { type: "string" } } }, ["system"]),
    },
    label: (i) => `Reading ${str(i.system)}${i.section ? ` (${str(i.section)})` : ""}`,
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const view = scrub(resolveSystem(systemPath(i.system)).view(ctx.world(), new URLSearchParams((i.query as Record<string, string>) ?? {})));
        if (!i.section) return { outline: outline(view), next: "Ask again with a section to read one part." };
        const part = at(view, str(i.section));
        if (part === undefined) return { error: `There is no part called "${str(i.section)}". The parts are: ${Object.keys((view ?? {}) as object).join(", ")}.` };
        if (!Array.isArray(part)) return part;
        const needle = str(i.search).toLowerCase();
        const rows = needle ? part.filter((r) => JSON.stringify(r).toLowerCase().includes(needle)) : part;
        const limit = Math.min(Math.max(Number(i.limit) || 10, 1), 40);
        return { rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), matching: rows.length, note: part.length >= 100 ? "Consoles list only the most recent few hundred of anything. Use lookup to search everything." : undefined };
      }),
  },

  act: {
    spec: {
      name: "act",
      description: "Do something at an institution's console, exactly as its staff would: enrol a person at NIA, add SIM stock, register a SIM, open an account, cash in at an agent, plug in an API, start a fraud run, and so on. list_actions gives each console's actions and their fields. Amounts are in cedis. The answer is what the console answered; if it refuses, the refusal says why.",
      parameters: obj({ system: S("the console's path, for example nia, telco/mtn, sim-agent/mtn, bank/gcb"), action: S("the action's name"), fields: { type: "object", description: "the action's fields", additionalProperties: true } }, ["system", "action"]),
    },
    label: (i) => `${str(i.system)}: ${str(i.action).replace(/_/g, " ")}`,
    askFirst(_ctx, i) {
      const info = CATALOGUE[str(i.system)]?.actions[str(i.action)];
      const f = (i.fields ?? {}) as Record<string, unknown>;
      const gone = (str(i.action) === "sim_status" && f.status === "deactivated") || info?.askFirst;
      return gone ? `${info?.does ?? str(i.action)} At ${str(i.system)}, with ${JSON.stringify(f)}.` : undefined;
    },
    run(ctx, i) {
      const path = systemPath(i.system);
      const system = resolveSystem(path);
      const name = str(i.action);
      const fields = { ...((i.fields as Record<string, unknown>) ?? {}), action: name };
      const staged = system.staged?.[name];
      if (staged) return staged(ctx.world(), fields);
      const action = system.actions[name];
      if (!action) throw new SimError(`${path.join("/")} has no action "${name}". It has: ${[...Object.keys(system.actions), ...Object.keys(system.staged ?? {})].join(", ")}.`);
      return locked(ctx.world(), () => action(ctx.world(), fields));
    },
  },

  create_test_customer: {
    spec: { name: "create_test_customer", description: "Make a customer ready to use in one go: a new person with a Ghana Card, a number registered to them, a wallet on medium KYC, a PIN you are told, and money in the wallet. The quickest way to get someone to pay or be paid. Works in an empty world too.", parameters: obj({ network: S("mtn, telecel or at", { enum: ["mtn", "telecel", "at"] }), amount: N("starting balance in cedis, 0 to 5000 (default 500)?") }, ["network"]) },
    label: (i) => `Creating a test customer on ${str(i.network).toUpperCase()}`,
    run: (ctx, i) => resolveSystem(["hub"]).staged!.test_customer(ctx.world(), { network: i.network, amount: i.amount }),
  },

  dial_ussd: {
    spec: {
      name: "dial_ussd",
      description: "Use a phone the way its owner would: dial a code and type replies, one after another, and get back every screen. The first input is the code dialled (the wallet code is *170# on MTN and *110# on Telecel and AT; *124# is airtime and data). The rest are what is typed at each screen: a menu choice, a number, an amount, a PIN. It stops when the session ends. If you do not know a menu, dial just the code first and read the screen. You only know the PIN of a customer you created or one the user told you.",
      parameters: obj({ number: S("the phone's number"), inputs: { type: "array", items: { type: "string" }, description: 'what is dialled, then each reply in order, for example ["*170#","1","1","0241234567","0241234567","20","lunch","4821"]' } }, ["number", "inputs"]),
    },
    label: (i) => {
      const inputs = Array.isArray(i.inputs) ? i.inputs : [];
      return `Dialling ${str(inputs[0])} on ${str(i.number)}${inputs.length > 1 ? ` and typing ${inputs.length - 1} ${inputs.length === 2 ? "reply" : "replies"}` : ""}`;
    },
    tell: (r) => {
      const screens = (r as { screens?: { screen: string }[] }).screens ?? [];
      return screens.length ? `Last screen: ${screens[screens.length - 1].screen.replace(/\s+/g, " ")}` : undefined;
    },
    async run(ctx, i) {
      const msisdn = normalizeMsisdn(str(i.number));
      const inputs = (Array.isArray(i.inputs) ? i.inputs : []).map(str).slice(0, 25);
      if (!inputs.length) throw new SimError("Give the code to dial as the first input");
      const screens: { typed: string; screen: string }[] = [];
      let sessionId: string | undefined;
      let ended = false;
      for (const input of inputs) {
        const r = await locked(ctx.world(), () => dial(ctx.world(), { sessionId, msisdn, input: input.slice(0, 182) }));
        // A PIN typed on the way is not echoed back into the conversation.
        screens.push({ typed: /^\d{4}$/.test(input) && /pin/i.test(screens[screens.length - 1]?.screen ?? "") ? "(PIN)" : input, screen: r.text });
        sessionId = r.sessionId;
        if (r.end) {
          ended = true;
          break;
        }
      }
      return { screens, sessionEnded: ended, note: ended ? undefined : "The session is still open and waiting for a reply; it will time out by itself." };
    },
  },

  phone_state: {
    spec: { name: "phone_state", description: "What a phone shows: whose it is, its network and wallet (KYC tier, status, balance), the latest texts it received, requests waiting for its owner's approval, and its recent transactions. Use it to check that a payment arrived or a text was delivered.", parameters: obj({ number: S("the phone's number") }, ["number"]) },
    label: (i) => `Looking at the phone ${str(i.number)}`,
    tell: (r) => {
      const p = r as { owner?: string; wallet?: { balance?: number } | string };
      return p.owner ? `${p.owner}${typeof p.wallet === "object" && p.wallet?.balance !== undefined ? `, GHS ${p.wallet.balance.toFixed(2)} in the wallet` : ", no wallet"}` : undefined;
    },
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const v = resolveSystem(["phone"]).view(ctx.world(), new URLSearchParams({ msisdn: normalizeMsisdn(str(i.number)) })) as { phone: null | { msisdn: string; telco: string; simStatus: string; owner: string; shortcode: string; approvalsPath: string; wallet: unknown; sms: unknown[]; approvals: unknown[]; recent: unknown[] } };
        if (!v.phone) return { error: "No registered SIM has that number." };
        const p = v.phone;
        return { number: p.msisdn, network: p.telco, sim: p.simStatus, owner: p.owner, walletCode: p.shortcode, whereToApprove: p.approvalsPath, wallet: p.wallet ?? "no wallet on this number", waitingForApproval: p.approvals, latestTexts: p.sms.slice(0, 8), recentTransactions: p.recent.slice(0, 8) };
      }),
  },

  send_text: {
    spec: { name: "send_text", description: "Send a text message from one phone to another.", parameters: obj({ from: S("the sender's number"), to: S("the recipient's number"), text: S("the message") }, ["from", "to", "text"]) },
    label: (i) => `Texting ${str(i.to)} from ${str(i.from)}`,
    run: (ctx, i) => locked(ctx.world(), () => resolveSystem(["phone"]).actions.sms_send(ctx.world(), { msisdn: str(i.from), to: str(i.to), text: str(i.text) })),
  },

  settings_read: {
    spec: {
      name: "settings_read",
      description: `Read an institution's settings: fees, limits, menus, rules, notification texts. Institutions: ${SURFACE_NAMES.join(", ")}. A network's settings hold its USSD menu, which is large: give a path to read one part, for example /fees, /menu/nodes/main, /cashOut. Without a path you get the top-level parts.`,
      parameters: obj({ institution: S("whose settings, for example telco.mtn, bog, bank.gcb"), path: S("a part of the settings, as a path starting with /?") }, ["institution"]),
    },
    label: (i) => `Reading the settings of ${str(i.institution)}${i.path ? ` (${str(i.path)})` : ""}`,
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const surface = str(i.institution);
        if (!(SURFACE_NAMES as readonly string[]).includes(surface)) throw new SimError(`There are no settings called "${surface}". They are: ${SURFACE_NAMES.join(", ")}.`);
        const all = getConfig(ctx.world().db, surface) as unknown;
        const path = str(i.path).split("/").filter(Boolean).join(".");
        if (!path) return { parts: outline(all), next: "Ask again with a path to read one part in full." };
        const part = at(all, path);
        return part === undefined ? { error: `Nothing at ${str(i.path)}.` } : part;
      }),
  },

  settings_change: {
    spec: {
      name: "settings_change",
      description: 'Change an institution\'s settings with JSON Patch operations (add, replace, remove), for example [{"op":"replace","path":"/kycTiers/minimum/daily","value":5000}]. Read the part first so the path and shape are right. The change is checked before it is saved, and every change can be undone.',
      parameters: obj({ institution: S("whose settings"), operations: { type: "array", description: "JSON Patch operations", items: obj({ op: S("add, replace or remove"), path: S("where, starting with /"), value: { description: "the new value (not for remove)" } }, ["op", "path"]) }, summary: S("one line saying what changed and why") }, ["institution", "operations", "summary"]),
    },
    label: (i) => `Changing the settings of ${str(i.institution)}: ${str(i.summary)}`,
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const w = ctx.world();
        const surface = str(i.institution);
        if (!(SURFACE_NAMES as readonly string[]).includes(surface)) throw new SimError(`There are no settings called "${surface}". They are: ${SURFACE_NAMES.join(", ")}.`);
        const changeId = setConfig(w.db, surface, applyPatch(getConfig(w.db, surface), i.operations as PatchOp[]), str(i.summary) || `Changed ${surface}`, "assistant");
        return { ok: true, changeId, note: "Saved. settings_undo with this changeId puts it back." };
      }),
  },

  settings_history: {
    spec: { name: "settings_history", description: "The latest changes made to settings, newest first: who made each, what changed, and its id for undoing.", parameters: obj({ institution: S("only this institution's changes?") }) },
    label: () => "Reading the history of settings changes",
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const rows = ctx.world().db.prepare(`SELECT * FROM config_history ${i.institution ? "WHERE surface = ?" : ""} ORDER BY id DESC LIMIT 15`).all(...(i.institution ? [str(i.institution)] : [])) as { id: number; surface: string; before: string; after: string; summary: string; author: string; at: number; undone_by: number | null }[];
        return rows.map((r) => ({ changeId: r.id, institution: r.surface, summary: r.summary, by: r.author, at: new Date(r.at).toISOString(), undone: !!r.undone_by, changed: diffJson(JSON.parse(r.before), JSON.parse(r.after)).slice(0, 12) }));
      }),
  },

  settings_undo: {
    spec: { name: "settings_undo", description: "Undo one change to settings, by its changeId.", parameters: obj({ changeId: N("the change to undo") }, ["changeId"]) },
    label: (i) => `Undoing settings change ${str(i.changeId)}`,
    run: (ctx, i) => withLock(ctx.world(), () => ({ ok: true, changeId: undoChange(ctx.world().db, Number(i.changeId), "assistant") })),
  },

  save_point: {
    spec: { name: "save_point", description: "Save the whole world as it is now, so it can be rolled back to. Do this before a large or risky change.", parameters: obj({ label: S("a name for it") }, ["label"]) },
    label: (i) => `Saving the world as "${str(i.label)}"`,
    run: (ctx, i) => snapshotWorld(ctx.team, str(i.label) || "Save point"),
  },

  list_save_points: {
    spec: { name: "list_save_points", description: "The team's save points, newest first.", parameters: obj({}) },
    label: () => "Listing save points",
    run: (ctx) => listSnapshots(ctx.team),
  },

  roll_back: {
    spec: { name: "roll_back", description: "Roll the whole world back to a save point. Everything done since is lost. The user is asked to approve first.", parameters: obj({ id: S("the save point's id") }, ["id"]) },
    label: (i) => `Rolling the world back to save point ${str(i.id)}`,
    askFirst: (ctx, i) => `Roll the whole world back to the save point "${listSnapshots(ctx.team).find((s) => s.id === str(i.id))?.label ?? str(i.id)}". Everything done since then will be lost.`,
    async run(ctx, i) {
      await restoreSnapshot(ctx.team, str(i.id));
      return { ok: true, note: "The world is as it was at that save point." };
    },
  },

  wipe_world: {
    spec: { name: "wipe_world", description: "Wipe the world back to an empty country: institutions and default settings, but no people, numbers or money. The user is asked to approve first.", parameters: obj({}) },
    label: () => "Wiping the world back to an empty country",
    askFirst: () => "Wipe the whole world back to an empty country. Everything the team has built, and the simulated country if it is loaded, will be gone. (Take a save point first if you may want it back.)",
    async run(ctx) {
      await resetWorld(ctx.team);
      return { ok: true, note: "The world is empty." };
    },
  },

  load_simulated_country: {
    spec: { name: "load_simulated_country", description: "Fill the world with the ready-made country: thousands of people, numbers, wallets, agents, merchants and bank accounts, and three months of transactions, part of them labelled fraud. It replaces what is in the world; what was there is kept as a save point. Can take up to a minute. The user is asked to approve first unless the world is empty.", parameters: obj({}) },
    label: () => "Loading the simulated country",
    askFirst: (ctx) => (count(ctx.world().db, "SELECT COUNT(*) AS n FROM persons") ? "Replace what is in the world with the simulated country. What is there now is kept as a save point, so it can be rolled back to." : undefined),
    async run(ctx) {
      const w = await loadSimulated(ctx.team);
      const s = simulatedSummary(w);
      return { ok: true, loaded: s ? { transactions: s.transactions, fraud: s.fraud, people: s.people, wallets: s.wallets } : "the simulated country" };
    },
  },

  fraud_run: {
    spec: {
      name: "fraud_run",
      description: "Start the fraud simulator: it plays fraud incidents of the kinds asked for, live, through the world, with honest activity alongside. With no application named, incidents are played against the APIs plugged into the institutions; with one, every step is sent to that connected application. It runs in the background: wait a few seconds, then read fraud_results. It needs the simulated country loaded.",
      parameters: obj({ kinds: { description: "all, one kind, or a list of kinds (reversal_scam, pin_phishing, sim_swap, agent_fraud, mule_chain, fake_promo, rtp_abuse, fake_merchant, relative_impersonation, limit_splitting, pin_guessing)" }, incidents: N("how many incidents (default 20)?"), ordinary: N("how many pieces of honest activity alongside?"), application: S("the name or id of a connected application to send them to?") }, ["kinds"]),
    },
    label: (i) => `Starting a fraud run (${Array.isArray(i.kinds) ? i.kinds.join(", ") : str(i.kinds)})`,
    run: (ctx, i) => locked(ctx.world(), () => resolveSystem(["fraud"]).actions.run(ctx.world(), { kinds: i.kinds, incidents: i.incidents, ordinary: i.ordinary ?? "", app: appId(ctx.world(), i.application) })),
  },

  fraud_results: {
    spec: { name: "fraud_results", description: "How the latest fraud run went: whether it is still running, how many incidents were stopped, held before cash-out or got through, by kind; how much honest activity was blocked by mistake; what stopped what; and the last few incidents with what happened in each. Also says if the simulator is not ready and why.", parameters: obj({ incidents: N("how many incidents to list, up to 15 (default 5)?") }) },
    label: () => "Reading the fraud results",
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const r = resolveSystem(["fraud"]).view(ctx.world(), new URLSearchParams()) as { running: boolean; notReady: string | null; pluggedIn: number; apps: unknown[]; latest: null | (Record<string, unknown> & { incidents: (Record<string, unknown> & { trail?: unknown })[] }) };
        if (!r.latest) return { running: r.running, notReady: r.notReady, pluggedInApis: r.pluggedIn, connectedApplications: r.apps, latest: "No run yet." };
        const { incidents, ...run } = r.latest;
        const n = Math.min(Math.max(Number(i.incidents) || 5, 0), 15);
        return { running: r.running, notReady: r.notReady, pluggedInApis: r.pluggedIn, connectedApplications: r.apps, run, incidents: incidents.slice(0, n).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "trail"))) };
      }),
  },

  fraud_stop: {
    spec: { name: "fraud_stop", description: "Stop the fraud run in progress after the incident being played.", parameters: obj({}) },
    label: () => "Stopping the fraud run",
    run: (ctx) => locked(ctx.world(), () => resolveSystem(["fraud"]).actions.stop(ctx.world(), {})),
  },

  list_bridges: {
    spec: { name: "list_bridges", description: "The team's bridges: laptops running the bridge program so the sandbox can reach an API on them, and whether each is connected right now. A connected bridge named laptop is reached at the address bridge://laptop.", parameters: obj({}) },
    label: () => "Checking which laptops are connected through the bridge",
    run: (ctx) => {
      const bridges = listBridges(ctx.world().id);
      return bridges.length ? bridges : "No bridge has connected. The team starts one on their laptop with the bridge program from the documentation.";
    },
  },

  plugin_points: {
    spec: { name: "plugin_points", description: "The steps an outside API can be plugged into: each step's name, which kind of institution asks, when, and what the API may answer.", parameters: obj({}) },
    label: () => "Listing the steps an API can be plugged into",
    run: () => Object.entries(POINTS).map(([id, p]) => ({ step: id, askedBy: p.who.join(", "), when: p.when, canAnswer: p.answers.join(", ") || "nothing: it is only told" })),
  },

  describe_data: {
    spec: { name: "describe_data", description: "The tables of stored data that lookup and summarise can read, with what each holds. Give a table to get its columns.", parameters: obj({ table: S("a table's name?") }) },
    label: (i) => (i.table ? `Checking what the ${str(i.table)} table holds` : "Checking what data can be searched"),
    run: (ctx, i) => (i.table ? { table: str(i.table), holds: TABLES[str(i.table)]?.what, columns: columnsOf(ctx.world(), str(i.table)), note: "Money is in cedis. Times are dates." } : Object.fromEntries(Object.entries(TABLES).map(([t, x]) => [t, x.what]))),
  },

  lookup: {
    spec: {
      name: "lookup",
      description: "Find rows in the stored data: people, numbers, wallets, transactions, calls, texts, complaints and more (describe_data lists the tables and their columns). Unlike a console, this searches everything, not only the most recent. Up to 50 rows.",
      parameters: obj({ table: S("the table to read"), where: WHERE, columns: { type: "array", items: { type: "string" }, description: "only these columns?" }, orderBy: S("a column to sort by?"), descending: { type: "boolean", description: "largest or newest first?" }, limit: N("how many rows, up to 50 (default 10)?") }, ["table"]),
    },
    label: (i) => `Searching ${str(i.table)}`,
    tell: (r) => `${(r as { matching: number }).matching} found`,
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const w = ctx.world();
        const table = str(i.table);
        const cols = columnsOf(w, table);
        const wanted = Array.isArray(i.columns) && i.columns.length ? (i.columns as unknown[]).map(str) : cols;
        const bad = wanted.find((c) => !cols.includes(c));
        if (bad) throw new SimError(`There is no column "${bad}" in ${table}. The columns are: ${cols.join(", ")}.`);
        if (i.orderBy && !cols.includes(str(i.orderBy))) throw new SimError(`Cannot sort by "${str(i.orderBy)}". The columns are: ${cols.join(", ")}.`);
        const c = conditions(cols, i.where);
        const limit = Math.min(Math.max(Number(i.limit) || 10, 1), 50);
        const rows = w.db.prepare(`SELECT ${wanted.join(", ")} FROM ${table} ${c.sql} ${i.orderBy ? `ORDER BY ${str(i.orderBy)} ${i.descending ? "DESC" : "ASC"}` : ""} LIMIT ?`).all(...c.args, limit) as Record<string, unknown>[];
        const matching = count(w.db, `SELECT COUNT(*) AS n FROM ${table} ${c.sql}`, ...c.args);
        return { rows: rows.map(readable), shown: rows.length, matching };
      }),
  },

  summarise: {
    spec: {
      name: "summarise",
      description: "Count or add up rows of stored data, optionally in groups: how many transactions of each type, the total sent per channel, how many failed payments by reason, how many fraud cases of each kind. Up to 50 groups, largest first.",
      parameters: obj({ table: S("the table to read"), where: WHERE, groupBy: { type: "array", items: { type: "string" }, description: "up to two columns to group by?" }, measure: S("count (default), or sum, avg, min or max of a column, written as sum:amount?") }, ["table"]),
    },
    label: (i) => `Adding up ${str(i.table)}`,
    run: (ctx, i) =>
      withLock(ctx.world(), () => {
        const w = ctx.world();
        const table = str(i.table);
        const cols = columnsOf(w, table);
        const groups = (Array.isArray(i.groupBy) ? (i.groupBy as unknown[]).map(str) : []).slice(0, 2);
        const bad = groups.find((c) => !cols.includes(c));
        if (bad) throw new SimError(`Cannot group by "${bad}". The columns are: ${cols.join(", ")}.`);
        const [fn, column] = (str(i.measure) || "count").toLowerCase().split(":");
        if (!["count", "sum", "avg", "min", "max"].includes(fn)) throw new SimError("The measure is count, or sum, avg, min or max of a column (sum:amount)");
        if (fn !== "count" && !cols.includes(column)) throw new SimError(`There is no column "${column}" to ${fn}. The columns are: ${cols.join(", ")}.`);
        const c = conditions(cols, i.where);
        const value = fn === "count" ? "COUNT(*)" : `${fn.toUpperCase()}(${column})`;
        const rows = w.db.prepare(`SELECT ${[...groups, `${value} AS result`].join(", ")} FROM ${table} ${c.sql} ${groups.length ? `GROUP BY ${groups.join(", ")}` : ""} ORDER BY result DESC LIMIT 50`).all(...c.args) as Record<string, unknown>[];
        const money = fn !== "count" && MONEY.has(column);
        return rows.map((r) => ({ ...readable(r), result: money && typeof r.result === "number" ? Math.round(r.result) / 100 : r.result }));
      }),
  },

  transaction: {
    spec: { name: "transaction", description: "One transaction in full: who paid whom, through what, the fee, why it failed if it did, and the ledger entries behind it.", parameters: obj({ id: S("the transaction's id (tx_…)") }, ["id"]) },
    label: (i) => `Looking at transaction ${str(i.id)}`,
    run: (ctx, i) => withLock(ctx.world(), () => resolveSystem(["hub"]).actions.txn(ctx.world(), { txnId: str(i.id) })),
  },

  read_documentation: {
    spec: {
      name: "read_documentation",
      description: "The sandbox's documentation: getting started, the starter kits and the bridge, every API with its endpoints and examples, the plug-in points and what each sends, the simulated data, the Fraud API, and what to do when something goes wrong. With nothing, you get the list of sections. With a section id you get that section. With search you get the sections that mention those words. Examples in it use the placeholders YOUR-TEAM and YOUR-TEAM-KEY; the team's own values are on their Documentation page.",
      parameters: obj({ section: S("a section's id?"), search: S("words to look for?") }),
    },
    label: (i) => (i.section ? `Reading the documentation on ${str(i.section)}` : i.search ? `Searching the documentation for "${str(i.search)}"` : "Looking at what the documentation covers"),
    async run(ctx, i) {
      const sections = await documentation(ctx.origin);
      if (!sections.length) return { error: "The documentation could not be read just now." };
      if (i.section) {
        const s = sections.find((x) => x.id === str(i.section));
        return s ? { id: s.id, title: s.title, text: s.text } : { error: `No section "${str(i.section)}". The sections are: ${sections.map((x) => x.id).join(", ")}.` };
      }
      if (i.search) {
        const words = str(i.search).toLowerCase().split(/\s+/).filter((x) => x.length > 2);
        const hits = sections
          .map((s) => ({ s, score: words.reduce((n, word) => n + (s.text.toLowerCase().split(word).length - 1) + (s.title.toLowerCase().includes(word) ? 5 : 0), 0) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4);
        return hits.length
          ? hits.map(({ s }) => {
              const first = Math.max(0, s.text.toLowerCase().indexOf(words[0]) - 200);
              return { id: s.id, title: s.title, excerpt: s.text.slice(first, first + 700) };
            })
          : { note: "Nothing in the documentation mentions that.", sections: sections.map((s) => `${s.id}: ${s.title}`) };
      }
      return sections.map((s) => `${s.id}: ${s.title}`);
    },
  },

  wait: {
    spec: { name: "wait", description: "Wait a few seconds, for something running in the background (a fraud run) to get further.", parameters: obj({ seconds: N("1 to 15") }, ["seconds"]) },
    label: (i) => `Waiting ${Math.min(Math.max(Number(i.seconds) || 3, 1), 15)} seconds`,
    run: (ctx, i) =>
      new Promise((done) => {
        const t = setTimeout(() => done({ waited: true }), Math.min(Math.max(Number(i.seconds) || 3, 1), 15) * 1000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          done({ waited: false });
        });
      }),
  },
};

/** A connected application's id, from the name or id the model gave. */
function appId(w: World, named: unknown): string | undefined {
  if (!named) return undefined;
  const apps = (resolveSystem(["fraud"]).view(w, new URLSearchParams()) as { apps: { id: string; name: string }[] }).apps;
  const found = apps.find((a) => a.id === str(named) || a.name.toLowerCase() === str(named).toLowerCase());
  if (!found) throw new SimError(`No connected application is called "${str(named)}". Connected: ${apps.map((a) => a.name).join(", ") || "none"}.`);
  return found.id;
}

export const tool = (name: string): Tool | undefined => TOOLS[name];
export const toolNames = () => Object.keys(TOOLS);

/** What a tool gave back, as the text handed to the model: never so long that it crowds out everything else. */
export function asText(result: unknown, limit = 7000): string {
  const text = typeof result === "string" ? result : JSON.stringify(scrub(result) ?? { ok: true });
  return text.length > limit ? `${text.slice(0, limit)}… (cut short: ${text.length - limit} more characters. Ask for less at a time: a section, a search, fewer rows.)` : text;
}

export { getWorld };
