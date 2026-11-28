import { BANK_IDS, SimError, isTelco, need, newId } from "./util";
import { count } from "./db";
import { bridgeAddress, bridgeConnected } from "./bridge";
import { callOut, checkUrl } from "./outside";
import { audit, stepAside, withLock, type World } from "./world";

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
  /** The API whose answer this is. */
  by?: string;
}

const ALLOW: Decision = { decision: "allow" };
const STRICT: Answer[] = ["allow", "warn", "delay", "reject"];

type Who = "telco" | "bank" | "switch";

export const POINTS: Record<string, { who: Who[]; when: string; answers: Answer[] }> = {
  "pin.set": { who: ["telco"], when: "A customer chooses or changes a wallet PIN", answers: ["allow", "reject"] },
  "wallet.open": { who: ["telco"], when: "A mobile money wallet is about to be opened", answers: ["allow", "reject"] },
  "menu.open": { who: ["telco"], when: "A customer opens the mobile money menu on their phone", answers: ["allow", "warn", "reject"] },
  "payment.authorize": { who: ["telco"], when: "A payment from one of this network's wallets is about to go through", answers: ["allow", "warn", "delay", "reject"] },
  "payment.receive": { who: ["telco", "bank"], when: "Money is about to arrive in one of this institution's wallets or accounts", answers: ["allow", "reject"] },
  "payment.request": { who: ["telco"], when: "A business or an agent asks one of this network's customers to approve a payment", answers: ["allow", "reject"] },
  "kyc.upgrade": { who: ["telco"], when: "A wallet's KYC level is about to be raised", answers: ["allow", "reject"] },
  "pin.reset": { who: ["telco"], when: "A wallet PIN is about to be reset at a service point", answers: ["allow", "reject"] },
  "business.onboard": { who: ["telco"], when: "A mobile money agent or a merchant is about to be signed up", answers: ["allow", "reject"] },
  "sim.register": { who: ["telco"], when: "A SIM is about to be registered to a Ghana Card", answers: ["allow", "reject"] },
  "sim.swap": { who: ["telco"], when: "A number is about to be moved to a replacement SIM", answers: ["allow", "reject"] },
  "sms.deliver": { who: ["telco"], when: "A text from a person or a business is about to reach one of this network's subscribers", answers: ["allow", "warn", "reject"] },
  "call.connect": { who: ["telco"], when: "A call is about to ring one of this network's subscribers", answers: ["allow", "warn", "reject"] },
  "transfer.authorize": { who: ["bank"], when: "A transfer from one of this bank's accounts is about to go through", answers: ["allow", "reject"] },
  "account.open": { who: ["bank"], when: "A bank account is about to be opened", answers: ["allow", "reject"] },
  "switch.route": { who: ["switch"], when: "A payment between two institutions is about to be passed on", answers: ["allow", "reject"] },
  events: { who: ["telco", "bank", "switch"], when: "After something has happened. For information only: the answer is ignored", answers: [] },
};

/** The institution that owns the national switch's plug-ins. */
export const SWITCH = "switch";
const kindOf = (institution: string): Who | undefined => (isTelco(institution) ? "telco" : BANK_IDS.includes(institution) ? "bank" : institution === SWITCH ? "switch" : undefined);

const CUSTOMER = { name: "Ama Mensah", ghanaCard: "GHA-123456789-0", dateOfBirth: "1994-03-12", gender: "F", region: "Ashanti" };
const WALLET = { msisdn: "0241234567", name: "Ama Mensah", network: "mtn", walletType: "person", kycTier: "medium", walletOpenedAt: "2026-11-02T09:14:00.000Z" };
// Someone at another network: only what travels with a payment. Their KYC level and wallet age stay with Telecel.
const OTHER = { msisdn: "0209876543", name: "Kojo Boateng", network: "telecel", walletType: "person" };
const ACCOUNT = { bank: "gcb", bankName: "GCB Bank", accountNumber: "0401000012", name: "Ama Mensah", accountOpenedAt: "2026-11-03T10:00:00.000Z" };
const POINT = { id: "sa_1a2b3c", name: "Adum Service Centre", kind: "service_centre", town: "Kumasi" };

/** An example of what an institution sends at each step: used in the API reference and by the console's "Send a test" button. */
export const SAMPLES: Record<string, Record<string, unknown>> = {
  // The PIN itself never leaves the network: only what its checks found.
  "pin.set": { msisdn: "0241234567", reason: "new_wallet", network: "mtn", pinChecks: { allSameDigit: false, inSequence: false, commonPin: false, endOfPhoneNumber: false, birthYear: false, birthDayAndMonth: false }, customer: CUSTOMER },
  "wallet.open": { msisdn: "0241234567", network: "mtn", walletType: "person", walletName: "Ama Mensah", kycTier: "minimum", openedBy: "self-registration (USSD)", customer: CUSTOMER, simRegisteredAt: "2026-11-02T09:02:00.000Z", lastSimSwapAt: null, walletsOnThisGhanaCard: 0 },
  "menu.open": { msisdn: "0241234567", network: "mtn", hasWallet: true, customer: CUSTOMER, wallet: { kycTier: "medium", walletOpenedAt: "2026-11-02T09:14:00.000Z", status: "active" }, lastSimSwapAt: null, onCallWith: null },
  "payment.authorize": {
    type: "p2p",
    channel: "ussd",
    amount: 50,
    fee: 0.38,
    reference: "lunch",
    payer: { ...WALLET, balance: 1250.5, lastSimSwapAt: null, onCallWith: null, paymentsInLast24Hours: 1, amountSentInLast24Hours: 40 },
    payee: OTHER,
    paymentsToThisPayeeBefore: 3,
    afterDelay: false,
  },
  "payment.receive": {
    type: "p2p",
    amount: 50,
    reference: "lunch",
    payer: OTHER,
    payee: { ...WALLET, balance: 1250.5, paymentsReceivedInLast24Hours: 2, differentPayersInLast24Hours: 2, amountReceivedInLast24Hours: 90 },
    paymentsFromThisPayerBefore: 3,
  },
  "payment.request": {
    kind: "payment_request",
    amount: 120,
    message: "Order 1042",
    requester: { msisdn: "0551112223", name: "Esi Provisions", network: "mtn", walletType: "merchant", kycTier: "enhanced", walletOpenedAt: "2026-11-04T08:00:00.000Z" },
    customer: WALLET,
    customerHasPaidThisRequesterBefore: true,
    requestsFromThisRequesterToday: 4,
    chargedWithoutAsking: false,
  },
  "kyc.upgrade": { msisdn: "0241234567", network: "mtn", from: "minimum", to: "medium", requestedBy: "agent 200001", customer: CUSTOMER, walletOpenedAt: "2026-11-02T09:14:00.000Z", proofOfAddress: null },
  "pin.reset": { msisdn: "0241234567", network: "mtn", requestedBy: "sa_1a2b3c", customer: CUSTOMER, walletBalance: 1250.5, walletStatus: "locked", lastSimSwapAt: null, pinResetsBefore: 0 },
  "business.onboard": { type: "merchant", businessName: "Esi Provisions", category: "Groceries", town: "Kumasi", msisdn: "0551112223", network: "mtn", owner: CUSTOMER, businessLinesAlreadyOnThisGhanaCard: 0 },
  "sim.register": { msisdn: "0241234567", network: "mtn", registeredBy: POINT, customer: CUSTOMER, simsAlreadyOnThisGhanaCard: 1, primaryNumber: "0201112223" },
  "sim.swap": { msisdn: "0241234567", network: "mtn", replacedBy: POINT, customer: CUSTOMER, simRegisteredAt: "2026-11-02T09:02:00.000Z", previousSwapAt: null, simStatus: "active", hasWallet: true, walletBalance: 1250.5, swapsOnThisNumberBefore: 0 },
  // A text between people: who, how and how often, never what it says. (A business's texts also carry "text".)
  "sms.deliver": { from: "0209876543", fromType: "person", fromNetwork: "telecel", to: "0241234567", toNetwork: "mtn", parts: 1, senderSimRegisteredAt: null, numbersTheSenderTextedToday: 2, textsBetweenThemBefore: 6 },
  "call.connect": { from: "0209876543", fromNetwork: "telecel", callerSimRegisteredAt: null, to: "0241234567", toNetwork: "mtn", callsBetweenThemBefore: 2, numbersTheCallerHasRungToday: 3 },
  "transfer.authorize": { type: "bank_to_wallet", amount: 200, fee: 1, reference: "rent", from: { ...ACCOUNT, balance: 5400 }, to: OTHER },
  "account.open": { bank: "gcb", customer: CUSTOMER, accountsAtOtherBanks: 1, walletsOnThisGhanaCard: 1 },
  "switch.route": { from: "mtn", fromName: "MTN MoMo", to: "telecel", toName: "Telecel Cash", amount: 50, destination: "0209876543", paymentsRoutedBetweenThemToday: 12 },
  events: { event: "payment.completed", type: "p2p", channel: "ussd", amount: 50, fee: 0.38, payer: WALLET, payee: OTHER, transactionId: "tx_9f8e7d6c5b4a3210", continuedAfterWarning: false },
};

/** What an institution tells APIs plugged in at "events". */
export const EVENTS: Record<string, string> = {
  "payment.completed": "A payment from one of the network's wallets went through",
  "payment.warning_shown": "A customer was shown a warning from a plugged-in API",
  "payment.cancelled_after_warning": "The customer read the warning and cancelled",
  "wallet.opened": "A wallet was opened",
  "wallet.locked": "A wallet was locked after too many wrong PINs",
  "wallet.status_changed": "A wallet was frozen or unfrozen",
  "kyc.upgraded": "A wallet's KYC level was raised",
  "pin.changed": "A customer changed their wallet PIN",
  "pin.reset": "A wallet PIN was reset at a service point",
  "sim.registered": "A SIM was registered",
  "sim.swapped": "A number was moved to a replacement SIM",
  "sim.status_changed": "A number was blocked, unblocked or disconnected",
  "complaint.opened": "A customer made a complaint to customer care",
  "transfer.completed": "A transfer from one of the bank's accounts went through",
  "account.opened": "A bank account was opened",
  "payment.routed": "The national switch passed a payment from one institution to another",
};

export const pointsFor = (institution: string) => Object.entries(POINTS).filter(([, p]) => p.who.includes(kindOf(institution) as Who));

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

const active = (w: World, institution: string, point: string): Integration[] =>
  w.direct
    ? // An application under test by the fraud simulator stands in for every plugged-in API, at every step.
      [{ id: w.direct.id, institution, point, name: w.direct.name, url: w.direct.url, enabled: 1, fail_open: 1, timeout_ms: 3000, calls: 0, created_at: 0 }]
    : (w.db.prepare("SELECT * FROM integrations WHERE institution = ? AND point = ? AND enabled = 1 ORDER BY created_at").all(institution, point) as unknown as Integration[]);

export function listIntegrations(w: World, institution: string) {
  const rows = w.db.prepare("SELECT * FROM integrations WHERE institution = ? ORDER BY created_at").all(institution) as unknown as Integration[];
  return rows.map((i) => {
    // For an API on a laptop: whether its bridge is calling in right now.
    const via = /^bridge:/i.test(i.url) ? bridgeAddress(i.url) : undefined;
    return {
      id: i.id, point: i.point, when: POINTS[i.point]?.when ?? i.point, name: i.name, url: i.url, enabled: !!i.enabled, failOpen: !!i.fail_open, timeoutMs: i.timeout_ms, calls: i.calls,
      bridge: via ? { name: via.name, connected: bridgeConnected(w.id, via.name) } : undefined,
    };
  });
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
  if (known) {
    w.watch?.({ key, institution, point, decision: known.decision, message: known.message, by: known.by });
    return known;
  }
  // Nothing is in a position to wait for an answer (a script calling the simulation directly): carry on.
  if (!w.asking) return ALLOW;
  throw new Ask(institution, point, payload, key);
}

/** What to write down about one call to a plugged-in API. */
interface Note {
  i: Integration;
  point: string;
  request: unknown;
  decision: string;
  message: string | undefined;
  ms: number;
}

function record(w: World, n: Note) {
  // An application under test by the fraud simulator is not one of the institution's own plug-ins; the simulator keeps its own record.
  if (n.i.id.startsWith("app_")) return;
  w.db
    .prepare("INSERT INTO integration_calls(at, integration_id, institution, point, request, decision, message, ms) VALUES(?,?,?,?,?,?,?,?)")
    .run(w.now, n.i.id, n.i.institution, n.point, JSON.stringify(n.request).slice(0, 2000), n.decision, n.message?.slice(0, 300) ?? null, n.ms);
  w.db.prepare("UPDATE integrations SET calls = calls + 1 WHERE id = ?").run(n.i.id);
  // Keep the log short.
  w.db.prepare("DELETE FROM integration_calls WHERE institution = ? AND id <= (SELECT MAX(id) FROM integration_calls WHERE institution = ?) - 500").run(n.i.institution, n.i.institution);
}

/**
 * `at` is the time in the world when the question is asked. It is usually now, but the fraud simulator plays
 * incidents at times of its own, so an API that compares times (a SIM swapped in the last day?) must use it
 * rather than its own clock.
 */
const post = (world: string, i: Integration, point: string, data: unknown, at = Date.now()) =>
  callOut(i.url, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ point, institution: i.institution, world, at: new Date(at).toISOString(), data }),
    timeoutMs: i.timeout_ms,
    world,
  });

/**
 * Asks one plugged-in API. An API that fails to answer is treated as its owner chose: carry on, or refuse.
 * This touches nothing in the world, so other requests can be served while it waits; what to write down
 * about the call is handed back with the answer.
 */
async function ask(world: string, i: Integration, point: string, payload: unknown, at?: number): Promise<{ decision: Decision; note: Note }> {
  const started = Date.now();
  const allowed = POINTS[point].answers;
  const note = (decision: string, message: string | undefined): Note => ({ i, point, request: payload, decision, message, ms: Date.now() - started });
  try {
    const r = await post(world, i, point, payload, at);
    if (r.status < 200 || r.status >= 300) throw new Error(`answered with status ${r.status}`);
    const j = JSON.parse(r.body) as { decision?: string; message?: unknown; minutes?: unknown };
    if (!allowed.includes(j.decision as Answer)) throw new Error(`answered "${j.decision}", but this step accepts: ${allowed.join(", ")}`);
    const d: Decision = { decision: j.decision as Answer, message: typeof j.message === "string" ? j.message.slice(0, 300) : undefined, minutes: Number(j.minutes) > 0 ? Math.min(Number(j.minutes), 7 * 24 * 60) : undefined };
    return { decision: d, note: note(d.decision, d.message) };
  } catch (e) {
    const why = /^No answer within/.test((e as Error).message) ? `no answer within ${i.timeout_ms} ms` : (e as Error).message;
    return {
      decision: i.fail_open ? ALLOW : { decision: "reject", message: "This service is temporarily unavailable. Please try again later." },
      note: note("error", `${why}; ${i.fail_open ? "carried on" : "refused"}`),
    };
  }
}

/** Sends an example request to a plugged-in API so its owner can see how it answers, without doing anything for real. */
export async function testIntegration(w: World, institution: string, id: unknown): Promise<string> {
  const i = own(w, institution, id);
  if (i.point === "events") {
    await flush(w, [{ institution, event: String(SAMPLES.events.event), data: SAMPLES.events }], [i], false);
  } else {
    record(w, (await ask(w.id, i, i.point, SAMPLES[i.point])).note);
  }
  const last = w.db.prepare("SELECT decision, message, ms FROM integration_calls WHERE integration_id = ? ORDER BY id DESC LIMIT 1").get(i.id) as { decision: string; message: string | null; ms: number };
  if (last.decision === "error") return `"${i.name}" did not answer properly: ${last.message}.`;
  if (last.decision === "sent") return `"${i.name}" received the example event in ${last.ms} ms.`;
  return `"${i.name}" answered "${last.decision}"${last.message ? ` with the message "${last.message}"` : ""} in ${last.ms} ms.`;
}

/**
 * Fetches the answer a step is waiting for. When several APIs are plugged into one step, the strictest answer wins.
 *
 * While the APIs are being asked, this request gives up its turn, so everything else on the world carries on:
 * above all the API itself, which may well ask the sandbox something (was this SIM swapped lately?) before it
 * answers. The request has undone everything it did, so nothing is half-finished while others are served. What
 * belongs to it alone (the answers it has so far, and what the fraud simulator set up for its step) is put away
 * for the wait and put back afterwards.
 */
async function settle(w: World, a: Ask) {
  const to = active(w, a.institution, a.point);
  // The world's time at the moment of asking, read before the simulator's clock is put away for the wait.
  const at = w.now;
  const mine = { answers: w.answers, watch: w.watch, direct: w.direct, clock: w.clock };
  Object.assign(w, { answers: new Map(), watch: undefined, direct: undefined, clock: undefined, asking: false, outbox: [] });
  let replies: Awaited<ReturnType<typeof ask>>[];
  try {
    replies = await stepAside(w, () => Promise.all(to.map((i) => ask(w.id, i, a.point, a.payload, at))));
  } finally {
    Object.assign(w, { ...mine, asking: true, outbox: [] });
  }
  for (const r of replies) record(w, r.note);
  const answers = replies.map((r, n) => ({ ...r.decision, by: to[n].name }));
  w.answers.set(a.key, answers.reduce((x, y) => (STRICT.indexOf(y.decision) > STRICT.indexOf(x.decision) ? y : x), ALLOW));
}

/** Tells plugged-in APIs that something happened. Queued until the request that caused it has succeeded. */
export function emit(w: World, institution: string, event: string, data: unknown) {
  if (w.asking && active(w, institution, "events").length) w.outbox.push({ institution, event, data });
}

async function flush(w: World, events: World["outbox"], only?: Integration[], queued = true) {
  // Who is told is settled now, before anything is sent: by the time the sending is done the world may be serving someone else.
  const told = events.map((e) => [e, only ?? active(w, e.institution, "events")] as const);
  for (const [e, to] of told) {
    for (const i of to) {
      const started = Date.now();
      const payload = { event: e.event, ...(e.data as object) };
      let outcome: [string, string];
      try {
        const r = await post(w.id, i, "events", payload);
        outcome = r.status >= 200 && r.status < 300 ? ["sent", e.event] : ["error", `${e.event}: answered with status ${r.status}`];
      } catch (err) {
        outcome = ["error", `${e.event}: ${/^No answer within/.test((err as Error).message) ? "no answer in time" : (err as Error).message}`];
      }
      // Written in turn with everything else that touches this world.
      const write = () => record(w, { i, point: "events", request: payload, decision: outcome[0], message: outcome[1], ms: Date.now() - started });
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
  if (!w.direct && !count(w.db, "SELECT COUNT(*) AS n FROM integrations WHERE enabled = 1")) return fn();
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
          // An ordinary refusal: what it recorded on the way (a failed payment, a wrong PIN) stands,
          // and so does anything it reported as having happened.
          if (w.db.isTransaction) w.db.exec("COMMIT");
          const events = w.outbox;
          w.outbox = [];
          if (events.length) void flush(w, events);
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
