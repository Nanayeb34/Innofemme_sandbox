import { BANK_IDS, SimError, isTelco, need, newId } from "./util";
import { count } from "./db";
import { audit, withLock, type World } from "./world";

/**
 * Plug-in points. An outside company can build an API and an institution can plug it into one of its
 * own steps: choosing a PIN, approving a payment, replacing a SIM, delivering a text. At that step the
 * institution sends the API what is about to happen and acts on its answer.
 *
 * The simulation itself runs without waiting on anything. When a step needs an outside answer it has
 * not got yet, it stops with an `Ask`; whoever is handling the request (see runWithIntegrations) undoes
 * the half-done work, calls the API, and runs the step again with the answer in hand.
 */

export type Answer = "allow" | "warn" | "delay" | "reject";

export interface Decision {
  decision: Answer;
  /** Shown to the customer, or recorded as the reason. */
  message?: string;
  /** For "delay": how long before the payment may be tried again. */
  minutes?: number;
}

const ALLOW: Decision = { decision: "allow" };
const STRICT: Answer[] = ["allow", "warn", "delay", "reject"];

export const POINTS: Record<string, { who: "telco" | "bank" | "both"; when: string; answers: Answer[] }> = {
  "pin.set": { who: "telco", when: "A customer chooses or changes a wallet PIN", answers: ["allow", "reject"] },
  "wallet.open": { who: "telco", when: "A mobile money wallet is about to be opened", answers: ["allow", "reject"] },
  "payment.authorize": { who: "telco", when: "A payment from one of this network's wallets is about to go through", answers: ["allow", "warn", "delay", "reject"] },
  "sim.register": { who: "telco", when: "A SIM is about to be registered to a Ghana Card", answers: ["allow", "reject"] },
  "sim.swap": { who: "telco", when: "A number is about to be moved to a replacement SIM", answers: ["allow", "reject"] },
  "sms.deliver": { who: "telco", when: "A text from a person or a business is about to reach one of this network's subscribers", answers: ["allow", "warn", "reject"] },
  "call.connect": { who: "telco", when: "A call is about to ring one of this network's subscribers", answers: ["allow", "warn", "reject"] },
  "transfer.authorize": { who: "bank", when: "A transfer from one of this bank's accounts is about to go through", answers: ["allow", "reject"] },
  events: { who: "both", when: "After something has happened (a payment, a SIM replacement, a new wallet…). For information only: the answer is ignored", answers: [] },
};

const CUSTOMER = { name: "Ama Mensah", ghanaCard: "GHA-123456789-0", dateOfBirth: "1994-03-12", gender: "F", region: "Ashanti" };
const WALLET = { msisdn: "0241234567", name: "Ama Mensah", network: "mtn", walletType: "person", kycTier: "medium", walletOpenedAt: "2026-11-02T09:14:00.000Z" };
const POINT = { id: "sa_1a2b3c", name: "Adum Service Centre", kind: "service_centre", town: "Kumasi" };

/** An example of what an institution sends at each step: used in the API reference and by the console's "Send a test" button. */
export const SAMPLES: Record<string, Record<string, unknown>> = {
  "pin.set": { msisdn: "0241234567", pin: "4567", reason: "new_wallet", network: "mtn", customer: CUSTOMER },
  "wallet.open": { msisdn: "0241234567", network: "mtn", walletType: "person", walletName: "Ama Mensah", kycTier: "minimum", openedBy: "self-registration (USSD)", customer: CUSTOMER, simRegisteredAt: "2026-11-02T09:02:00.000Z", lastSimSwapAt: null, walletsOnThisGhanaCard: 0 },
  "payment.authorize": {
    type: "p2p",
    channel: "ussd",
    amount: 500,
    fee: 0,
    reference: "school fees",
    payer: { ...WALLET, balance: 1250.5, lastSimSwapAt: null, onCallWith: "0209876543", paymentsInLast24Hours: 1, amountSentInLast24Hours: 40 },
    payee: { msisdn: "0209876543", name: "Kojo Boateng", network: "telecel", walletType: "person", kycTier: "minimum", walletOpenedAt: "2026-11-18T16:40:00.000Z" },
    paymentsToThisPayeeBefore: 0,
    afterDelay: false,
  },
  "sim.register": { msisdn: "0241234567", network: "mtn", registeredBy: POINT, customer: CUSTOMER, simsAlreadyOnThisGhanaCard: 1, primaryNumber: "0201112223" },
  "sim.swap": { msisdn: "0241234567", network: "mtn", replacedBy: POINT, customer: CUSTOMER, simRegisteredAt: "2026-11-02T09:02:00.000Z", previousSwapAt: null, simStatus: "active", hasWallet: true, walletBalance: 1250.5, swapsOnThisNumberBefore: 0 },
  "sms.deliver": { from: "0209876543", fromType: "person", fromNetwork: "telecel", to: "0241234567", toNetwork: "mtn", text: "Hello, I sent GHS 500 to your number by mistake. Please send it back.", textsBetweenThemBefore: 0 },
  "call.connect": { from: "0209876543", fromNetwork: "telecel", callerSimRegisteredAt: "2026-11-18T16:31:00.000Z", to: "0241234567", toNetwork: "mtn", callsBetweenThemBefore: 0, numbersTheCallerHasRungToday: 14 },
  "transfer.authorize": {
    type: "bank_to_wallet",
    amount: 2000,
    fee: 5,
    reference: "rent",
    from: { bank: "gcb", bankName: "GCB Bank", accountNumber: "0401000012", name: "Ama Mensah", accountOpenedAt: "2026-11-03T10:00:00.000Z", balance: 5400 },
    to: { msisdn: "0209876543", name: "Kojo Boateng", network: "telecel", walletType: "person", kycTier: "minimum", walletOpenedAt: "2026-11-18T16:40:00.000Z" },
  },
  events: { event: "payment.completed", type: "p2p", channel: "ussd", amount: 500, fee: 0, payer: WALLET, payee: { msisdn: "0209876543", name: "Kojo Boateng", network: "telecel" }, transactionId: "tx_9f8e7d6c5b4a3210", continuedAfterWarning: false },
};

/** What an institution tells APIs plugged in at "events". */
export const EVENTS: Record<string, string> = {
  "payment.completed": "A payment from one of the network's wallets went through",
  "payment.warning_shown": "A customer was shown a warning from a plugged-in API",
  "payment.cancelled_after_warning": "The customer read the warning and cancelled",
  "wallet.opened": "A wallet was opened",
  "pin.changed": "A customer changed their wallet PIN",
  "sim.registered": "A SIM was registered",
  "sim.swapped": "A number was moved to a replacement SIM",
  "transfer.completed": "A transfer from one of the bank's accounts went through",
};

export const pointsFor = (institution: string) => Object.entries(POINTS).filter(([, p]) => p.who === "both" || (p.who === "telco" ? isTelco(institution) : BANK_IDS.includes(institution)));

export interface Integration {
  id: string;
  institution: string;
  point: string;
  name: string;
  url: string;
  enabled: number;
  fail_open: number;
  timeout_ms: number;
  calls: number;
  created_at: number;
}

/** Addresses the sandbox will not call: cloud metadata services, which hold the server's own credentials. */
export function checkUrl(input: string | undefined): string {
  const url = String(need(input?.trim(), "The API's address"));
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    host = u.hostname;
  } catch {
    throw new SimError("The address must be a full http:// or https:// address");
  }
  if (host === "metadata.google.internal" || host.startsWith("169.254.")) throw new SimError("That address is not allowed");
  return url;
}

export function addIntegration(w: World, institution: string, input: { point?: string; name?: string; url?: string; failOpen?: unknown; timeoutMs?: unknown }): Integration {
  const point = String(need(input.point, "The step to plug into"));
  if (!pointsFor(institution).some(([p]) => p === point)) throw new SimError("This institution has no such step to plug into");
  const name = String(need(input.name?.trim(), "A name for the API")).slice(0, 60);
  const url = checkUrl(input.url);
  const timeout = Math.min(Math.max(Number(input.timeoutMs) || 2000, 200), 5000);
  const id = newId("int");
  w.db
    .prepare("INSERT INTO integrations(id, institution, point, name, url, fail_open, timeout_ms, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, institution, point, name, url, input.failOpen === false || input.failOpen === "false" ? 0 : 1, timeout, w.now);
  audit(w, institution, "integration", `Plugged in "${name}" at: ${POINTS[point].when.toLowerCase()}`);
  return w.db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as unknown as Integration;
}

function own(w: World, institution: string, id: unknown): Integration {
  const i = w.db.prepare("SELECT * FROM integrations WHERE id = ?").get(String(id)) as Integration | undefined;
  if (!i || i.institution !== institution) throw new SimError("Plugged-in API not found");
  return i;
}

export function setIntegrationEnabled(w: World, institution: string, id: unknown, enabled: boolean) {
  const i = own(w, institution, id);
  w.db.prepare("UPDATE integrations SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, i.id);
  audit(w, institution, "integration", `${enabled ? "Switched on" : "Switched off"} "${i.name}"`);
}

export function removeIntegration(w: World, institution: string, id: unknown) {
  const i = own(w, institution, id);
  w.db.prepare("DELETE FROM integrations WHERE id = ?").run(i.id);
  audit(w, institution, "integration", `Unplugged "${i.name}"`);
}

const active = (w: World, institution: string, point: string) =>
  w.db.prepare("SELECT * FROM integrations WHERE institution = ? AND point = ? AND enabled = 1 ORDER BY created_at").all(institution, point) as unknown as Integration[];

export function listIntegrations(w: World, institution: string) {
  const rows = w.db.prepare("SELECT * FROM integrations WHERE institution = ? ORDER BY created_at").all(institution) as unknown as Integration[];
  return rows.map((i) => ({ id: i.id, point: i.point, when: POINTS[i.point]?.when ?? i.point, name: i.name, url: i.url, enabled: !!i.enabled, failOpen: !!i.fail_open, timeoutMs: i.timeout_ms, calls: i.calls }));
}

export function integrationLog(w: World, institution: string, limit = 60) {
  const rows = w.db
    .prepare("SELECT c.*, i.name FROM integration_calls c LEFT JOIN integrations i ON i.id = c.integration_id WHERE c.institution = ? ORDER BY c.id DESC LIMIT ?")
    .all(institution, limit) as { id: number; at: number; point: string; request: string; decision: string; message: string | null; ms: number; name: string | null }[];
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), api: r.name ?? "(removed)", point: r.point, request: r.request, decision: r.decision, message: r.message, ms: r.ms }));
}

/** An outside API asked that the customer be warned before going ahead. On the phone it becomes "1) Continue 2) Cancel". */
export class Confirm extends SimError {}

/** A step is waiting on an outside API's answer. Not a failure: the request handler fetches the answer and runs the step again. */
export class Ask extends Error {
  constructor(
    public institution: string,
    public point: string,
    public payload: unknown,
    public key: string,
  ) {
    super(`waiting for an outside API at ${point}`);
  }
}

/**
 * Called by a step of the simulation: "may I go ahead?" With nothing plugged in, the answer is yes.
 * The payload must describe the situation and nothing that changes from one moment to the next,
 * because the step is run again once the answer arrives and must ask the same question.
 */
export function consult(w: World, institution: string, point: string, payload: unknown): Decision {
  if (!active(w, institution, point).length) return ALLOW;
  const key = `${institution}|${point}|${JSON.stringify(payload)}`;
  const known = w.answers.get(key) as Decision | undefined;
  if (known) return known;
  // Nothing is in a position to wait for an answer (a script calling the simulation directly): carry on.
  if (!w.asking) return ALLOW;
  throw new Ask(institution, point, payload, key);
}

function record(w: World, i: Integration, point: string, request: unknown, decision: string, message: string | undefined, ms: number) {
  w.db
    .prepare("INSERT INTO integration_calls(at, integration_id, institution, point, request, decision, message, ms) VALUES(?,?,?,?,?,?,?,?)")
    .run(w.now, i.id, i.institution, point, JSON.stringify(request).slice(0, 2000), decision, message?.slice(0, 300) ?? null, ms);
  w.db.prepare("UPDATE integrations SET calls = calls + 1 WHERE id = ?").run(i.id);
  // Keep the log short.
  w.db.prepare("DELETE FROM integration_calls WHERE institution = ? AND id <= (SELECT MAX(id) FROM integration_calls WHERE institution = ?) - 500").run(i.institution, i.institution);
}

async function post(w: World, i: Integration, point: string, data: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(i.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ point, institution: i.institution, world: w.id, at: new Date().toISOString(), data }),
    signal: AbortSignal.timeout(i.timeout_ms),
  });
  return { status: res.status, body: await res.text() };
}

/** Asks one plugged-in API. An API that fails to answer is treated as its owner chose: carry on, or refuse. */
async function ask(w: World, i: Integration, point: string, payload: unknown): Promise<Decision> {
  const started = Date.now();
  const allowed = POINTS[point].answers;
  try {
    const r = await post(w, i, point, payload);
    if (r.status < 200 || r.status >= 300) throw new Error(`answered with status ${r.status}`);
    const j = JSON.parse(r.body) as { decision?: string; message?: unknown; minutes?: unknown };
    if (!allowed.includes(j.decision as Answer)) throw new Error(`answered "${j.decision}", but this step accepts: ${allowed.join(", ")}`);
    const d: Decision = { decision: j.decision as Answer, message: typeof j.message === "string" ? j.message.slice(0, 300) : undefined, minutes: Number(j.minutes) > 0 ? Math.min(Number(j.minutes), 7 * 24 * 60) : undefined };
    record(w, i, point, payload, d.decision, d.message, Date.now() - started);
    return d;
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? `no answer within ${i.timeout_ms} ms` : (e as Error).message;
    record(w, i, point, payload, "error", `${why}; ${i.fail_open ? "carried on" : "refused"}`, Date.now() - started);
    return i.fail_open ? ALLOW : { decision: "reject", message: "This service is temporarily unavailable. Please try again later." };
  }
}

/** Sends an example request to a plugged-in API so its owner can see how it answers, without doing anything for real. */
export async function testIntegration(w: World, institution: string, id: unknown): Promise<string> {
  const i = own(w, institution, id);
  if (i.point === "events") {
    await flush(w, [{ institution, event: String(SAMPLES.events.event), data: SAMPLES.events }], [i], false);
  } else {
    await ask(w, i, i.point, SAMPLES[i.point]);
  }
  const last = w.db.prepare("SELECT decision, message, ms FROM integration_calls WHERE integration_id = ? ORDER BY id DESC LIMIT 1").get(i.id) as { decision: string; message: string | null; ms: number };
  if (last.decision === "error") return `"${i.name}" did not answer properly: ${last.message}.`;
  if (last.decision === "sent") return `"${i.name}" received the example event in ${last.ms} ms.`;
  return `"${i.name}" answered "${last.decision}"${last.message ? ` with the message "${last.message}"` : ""} in ${last.ms} ms.`;
}

/** Fetches the answer a step is waiting for. When several APIs are plugged into one step, the strictest answer wins. */
async function settle(w: World, a: Ask) {
  const answers = await Promise.all(active(w, a.institution, a.point).map((i) => ask(w, i, a.point, a.payload)));
  const strictest = answers.reduce((x, y) => (STRICT.indexOf(y.decision) > STRICT.indexOf(x.decision) ? y : x), ALLOW);
  w.answers.set(a.key, strictest);
}

/** Tells plugged-in APIs that something happened. Queued until the request that caused it has succeeded. */
export function emit(w: World, institution: string, event: string, data: unknown) {
  if (w.asking && active(w, institution, "events").length) w.outbox.push({ institution, event, data });
}

async function flush(w: World, events: World["outbox"], only?: Integration[], queued = true) {
  for (const e of events) {
    for (const i of only ?? active(w, e.institution, "events")) {
      const started = Date.now();
      const payload = { event: e.event, ...(e.data as object) };
      let outcome: [string, string];
      try {
        const r = await post(w, i, "events", payload);
        outcome = r.status >= 200 && r.status < 300 ? ["sent", e.event] : ["error", `${e.event}: answered with status ${r.status}`];
      } catch (err) {
        outcome = ["error", `${e.event}: ${(err as Error).name === "TimeoutError" ? "no answer in time" : (err as Error).message}`];
      }
      // Written in turn with everything else that touches this world.
      const write = () => record(w, i, "events", payload, outcome[0], outcome[1], Date.now() - started);
      if (queued) await withLock(w, write).catch(() => undefined);
      else write();
    }
  }
}

const copy = <K, V>(m: Map<K, V>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)] as [K, V]));

/**
 * Handles one request in a way that can wait for outside APIs. The work runs inside a database
 * transaction; if a step stops to ask an outside API, everything done so far is undone, the API is
 * called, and the work starts again with the answer available. Use it wherever a request comes in.
 */
export async function runWithIntegrations<T>(w: World, fn: () => T | Promise<T>): Promise<T> {
  if (w.asking) return fn(); // already inside one
  // With nothing plugged in anywhere there is nothing to wait for.
  if (!count(w.db, "SELECT COUNT(*) AS n FROM integrations WHERE enabled = 1")) return fn();
  w.asking = true;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const memory = { ussd: copy(w.ussd), otps: new Map(w.otps), calls: copy(w.calls), presence: new Map(w.presence), cooldowns: new Map(w.cooldowns) };
      w.outbox = [];
      w.db.exec("BEGIN");
      try {
        const out = await fn();
        w.db.exec("COMMIT");
        const events = w.outbox;
        w.outbox = [];
        if (events.length) void flush(w, events);
        return out;
      } catch (e) {
        if (!(e instanceof Ask)) {
          // An ordinary refusal: what it recorded on the way (a failed payment, a wrong PIN) stands.
          if (w.db.isTransaction) w.db.exec("COMMIT");
          throw e;
        }
        w.db.exec("ROLLBACK");
        Object.assign(w, memory);
        await settle(w, e);
      }
    }
    throw new SimError("Too many outside checks on one request. Please try again.");
  } finally {
    w.asking = false;
    w.answers.clear();
    w.outbox = [];
  }
}

/** One request at a time per world, and able to wait for plugged-in APIs. Use this wherever a request changes the world. */
export const locked = <T>(w: World, fn: () => T | Promise<T>): Promise<T> => withLock(w, () => runWithIntegrations(w, fn));
