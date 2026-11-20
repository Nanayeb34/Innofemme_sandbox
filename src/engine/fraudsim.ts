import { approve, createApproval, rejectApproval, type ApprovalRow } from "./approvals";
import { scriptedCall, scriptedCallEnd } from "./calls";
import { getConfig } from "./config/store";
import { count } from "./db";
import { Confirm, checkUrl, runWithIntegrations } from "./integrations";
import { feeFor } from "./ledger";
import { enrol } from "./nia";
import { bankToWallet, walletPay, type Receipt } from "./payments";
import { FIRST_F, FIRST_M, PLACES, Rng, SCENARIOS, SURNAMES } from "./simulate";
import { sendAppSms, sendText } from "./sms";
import * as telcoOps from "./telco";
import { ussd } from "./ussd";
import { HOUR, MINUTE, SimError, TELCOS, TELCO_INFO, cedis, newId, type Telco } from "./util";
import { audit, withLock, type World } from "./world";

/**
 * The fraud simulator. It plays fraud incidents of a chosen kind, live, through the sandbox's own
 * processes: the fraudster gets a line, reaches the victim by text or call, the victim's money
 * leaves, moves on and is cashed out. At each step the team's service is asked, as it would be for
 * real activity, and what it answers decides whether the incident goes on.
 *
 * The service under test is either the APIs plugged into the institutions, or one standalone
 * application that has been connected to the simulator and is asked at every step instead.
 * Ordinary activity is played alongside, so a service that stops everything is not mistaken for a
 * good one. The service is never told which requests were fraud; the results are kept here, for the
 * team's console.
 */

export const FRAUD_KINDS: Record<string, string> = { ...SCENARIOS, pin_guessing: "A thief with the victim's phone guesses the wallet PIN" };

/** How a simulated person reacts to what a service does. Shown with the results, so the numbers can be read. */
export const REACTIONS = {
  labelOnText: 0.5, // a victim who sees a warning label on the fraudster's text ignores the text
  labelOnCall: 0.5, // a victim who sees a warning on the incoming call screen hangs up
  noticeAtMenu: 0.2, // a victim shown a general notice before the menu thinks again
  warningAtPayment: 0.65, // a victim warned about this payment cancels it
  afterPause: 0.7, // a victim whose payment was paused does not try again
  ordinaryPutOff: 0.1, // an honest customer warned about an honest payment gives up
};

export interface TrailStep {
  what: string;
  result: string;
  point?: string;
  by?: string;
  answer?: string;
  message?: string;
}
interface Seen {
  key: string;
  institution: string;
  point: string;
  decision: string;
  message?: string;
  by?: string;
}
interface Line {
  id: string;
  msisdn: string;
  telco: Telco;
  pin: string;
  card: string;
  fingerprint: string;
  dob: string;
  balance: number;
  tier: string;
}
interface RunCtx {
  id: string;
  w: World;
  rng: Rng;
  app?: { id: string; name: string; url: string };
  stop: boolean;
  crook?: { line: Line; uses: number };
  /** Second wallets the fraudsters pass money through. Each is used a few times, then dropped. */
  mules: { line: Line; uses: number }[];
  /** The Ghana Card those wallets' lines are registered on, and how many it holds so far. */
  lender?: { person: PersonLite; held: number };
  shop?: Line;
  used: Set<string>;
}
interface PersonLite {
  id: string;
  ghana_card: string;
  fingerprint: string;
  dob: string;
  first_names: string;
  surname: string;
  town: string;
}

/** The incident could not be played for a reason that has nothing to do with the service under test. */
class Void extends Error {}

const running = new Map<string, RunCtx>();
const ghs = (n: number) => Math.round(n * 100);
const worst = (seen: Seen[]) => seen.find((s) => s.decision === "reject") ?? seen.find((s) => s.decision === "delay");
const warned = (seen: Seen[]) => seen.find((s) => s.decision === "warn");

class Incident {
  trail: TrailStep[] = [];
  who?: string;
  atRisk = 0;
  paid = 0;
  lost = 0;
  ended?: { outcome: string; summary: string; seen?: Seen };
  constructor(
    public r: RunCtx,
    public kind: "fraud" | "ordinary",
    public scenario: string,
    public rng: Rng,
  ) {}
  get w() {
    return this.r.w;
  }
  add(what: string, result: string, seen?: Seen) {
    this.trail.push({ what, result, point: seen?.point, by: seen?.by, answer: seen?.decision, message: seen?.message });
  }
  end(outcome: string, summary: string, seen?: Seen) {
    this.ended ??= { outcome, summary, seen };
  }
}

// ---------- playing one step ----------

type Done<T> = { ok: true; value: T; seen: Seen[] } | { ok: false; error: SimError; seen: Seen[] };

/** Runs one step in the world, with the service under test being asked wherever the sandbox would ask it, and notes what it answered. */
function step<T>(r: RunCtx, fn: () => T, at?: number): Promise<Done<T>> {
  return withLock(r.w, async () => {
    const seen = new Map<string, Seen>();
    r.w.watch = (s) => seen.set(s.key, s);
    r.w.clock = at;
    r.w.direct = r.app;
    try {
      const value = await runWithIntegrations(r.w, fn);
      return { ok: true as const, value, seen: [...seen.values()] };
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      return { ok: false as const, error: e, seen: [...seen.values()] };
    } finally {
      r.w.watch = undefined;
      r.w.clock = undefined;
      r.w.direct = undefined;
    }
  });
}
/** Something the simulator arranges itself, which no service is asked about. */
const quiet = <T>(r: RunCtx, fn: () => T): Promise<T> => withLock(r.w, fn);

interface Tried<T> {
  value?: T;
  /** The service blocked or paused it. */
  stop?: Seen;
  /** The service asked for a warning. */
  warn?: Seen;
  /** The warning has to be answered before the step can go on. */
  confirm?: boolean;
}
async function attempt<T>(inc: Incident, what: string, fn: () => T, at?: number): Promise<Tried<T>> {
  const d = await step(inc.r, fn, at);
  const stop = worst(d.seen);
  const warn = warned(d.seen);
  if (d.ok) return { value: d.value, stop, warn };
  if (d.error instanceof Confirm) {
    inc.add(what, "A warning was shown first", warn);
    return { warn, confirm: true };
  }
  if (stop) {
    inc.add(what, stop.decision === "delay" ? "Paused" : "Blocked", stop);
    return { stop };
  }
  throw new Void(`${what}: ${d.error.message}`);
}

// ---------- who takes part ----------

const LINE_SQL = `SELECT x.id, x.msisdn, x.telco, x.pin, x.balance, x.kyc_tier AS tier, p.ghana_card AS card, p.fingerprint, p.dob
  FROM wallets x JOIN persons p ON p.id = x.person_id JOIN sims s ON s.msisdn = x.msisdn`;
const lineOf = (w: World, msisdn: string) => w.db.prepare(`${LINE_SQL} WHERE x.msisdn = ?`).get(msisdn) as unknown as Line;

/** An established customer with money: not a line the simulator made, and not one whose SIM was just replaced. */
function customer(inc: Incident, min: number, where = ""): Line {
  const now = Date.now();
  const rows = inc.w.db
    .prepare(
      `${LINE_SQL} WHERE x.owner_type = 'person' AND x.status = 'active' AND s.status = 'active' AND x.balance >= ? AND x.created_at < ?
       AND (s.last_swap_at IS NULL OR s.last_swap_at < ?) ${where} ORDER BY x.id LIMIT 800`,
    )
    .all(min, now - 7 * 24 * HOUR, now - 48 * HOUR) as unknown as Line[];
  const free = rows.filter((l) => !inc.r.used.has(l.msisdn));
  if (!free.length) throw new Void("There is no customer left with enough money in their wallet. Load the simulated country, or put money into more wallets.");
  const v = inc.rng.pick(free);
  inc.r.used.add(v.msisdn);
  return v;
}
function agentOn(inc: Incident, telco: Telco, cash: number) {
  const rows = inc.w.db
    .prepare("SELECT a.code, a.cash, x.id, x.msisdn, x.pin, x.balance FROM momo_agents a JOIN wallets x ON x.id = a.wallet_id WHERE x.telco = ? AND a.status = 'active' AND x.status = 'active' ORDER BY a.cash DESC LIMIT 6")
    .all(telco) as { code: string; cash: number; id: string; msisdn: string; pin: string; balance: number }[];
  if (!rows.length) throw new Void(`There is no mobile money agent on ${TELCO_INFO[telco].name}.`);
  const ok = rows.filter((a) => a.cash >= cash);
  return ok.length ? inc.rng.pick(ok) : rows[0];
}
/** A network's SIM registration points: service centres first, registration agents last. The last one is where a fraudster goes. */
const points = (w: World, telco: Telco) => (w.db.prepare("SELECT id FROM sim_agents WHERE telco = ? AND status = 'active' ORDER BY kind = 'registration_agent', id").all(telco) as { id: string }[]).map((p) => p.id);

function newPerson(inc: Incident, minAge = 20, maxAge = 50): Promise<PersonLite> {
  const rng = inc.rng;
  const female = rng.chance(0.5);
  const place = rng.weighted(PLACES, (p) => p.weight);
  const born = new Date(Date.now() - (minAge * 365.25 + rng.next() * (maxAge - minAge) * 365.25) * 24 * HOUR).toISOString().slice(0, 10);
  const input = { firstNames: rng.pick(female ? FIRST_F : FIRST_M), surname: rng.pick(SURNAMES), dob: born, gender: female ? "F" : "M", region: place.region, town: rng.pick(place.towns) };
  return quiet(inc.r, () => {
    for (let i = 0; ; i++) {
      try {
        return enrol(inc.w, { ...input, firstNames: i ? `${input.firstNames} ${rng.pick(SURNAMES)}` : input.firstNames }) as unknown as PersonLite;
      } catch (e) {
        if (!(e instanceof SimError) || i > 4) throw e;
      }
    }
  });
}

/**
 * Someone gets a new line: a SIM registered against a Ghana Card at a registration point, then a
 * wallet. Each is a step the service under test is asked about. Returns nothing if it was refused.
 */
async function newLine(inc: Incident, who: string, o: { telco?: Telco; person?: PersonLite; tier?: "medium" | "minimum"; pin?: string; careless?: boolean } = {}): Promise<{ line?: Line; stop?: Seen; person: PersonLite }> {
  const w = inc.w;
  const person = o.person ?? (await newPerson(inc));
  const tier = o.tier ?? "medium";
  // Only MTN and AT let a subscriber open a wallet from the phone.
  const telco = o.telco ?? (tier === "minimum" ? inc.rng.pick(TELCOS.filter((t) => getConfig(w.db, `telco.${t}`).selfRegistration)) : inc.rng.pick(TELCOS));
  const all = points(w, telco);
  if (!all.length) throw new Void(`There is no SIM registration point on ${TELCO_INFO[telco].name}.`);
  const point = o.careless ? all[all.length - 1] : inc.rng.pick(all);
  await quiet(inc.r, () => {
    if (count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", telco) < 3) telcoOps.generateSims(w, telco, 20);
  });
  const reg = await attempt(inc, `${who} registers a new SIM at a registration point`, () => {
    try {
      return telcoOps.registerSim(w, telco, point, { card: person.ghana_card, fingerprint: person.fingerprint });
    } catch (e) {
      // A further SIM on the same card needs the code texted to the holder's first number.
      if (!(e instanceof SimError) || !/approval code/i.test(e.message)) throw e;
      return telcoOps.registerSim(w, telco, point, { card: person.ghana_card, fingerprint: person.fingerprint, otp: w.otps.get(`simreg:${person.id}`) });
    }
  });
  if (!reg.value) return { stop: reg.stop, person };
  const msisdn = reg.value.sim.msisdn;
  inc.add(`${who} registers a new SIM at a registration point`, `Registered ${msisdn} on ${TELCO_INFO[telco].name}`);
  const pin = o.pin ?? inc.rng.digits(4).replace(/^(\d)\1{3}$/, "2749");
  const open = await attempt(inc, `${who} opens a mobile money wallet`, () => (tier === "minimum" ? telcoOps.selfRegisterWallet(w, msisdn, pin) : telcoOps.agentRegisterWallet(w, telco, agentOn(inc, telco, 0).code, { msisdn, card: person.ghana_card, fingerprint: person.fingerprint, pin })));
  if (!open.value) return { stop: open.stop, person };
  inc.add(`${who} opens a mobile money wallet`, "Opened");
  inc.r.used.add(msisdn);
  return { line: lineOf(w, msisdn), person };
}

/** The fraudster's own line. A fraudster uses one line for a few victims, then gets another. */
async function fraudster(inc: Incident, fresh = false): Promise<Line | undefined> {
  const r = inc.r;
  if (!fresh && r.crook && r.crook.uses < 3) {
    r.crook.uses++;
    return r.crook.line;
  }
  const made = await newLine(inc, "The fraudster", { careless: true });
  if (!made.line) {
    inc.end("stopped", "The fraudster could not get a line to work from", made.stop);
    return;
  }
  if (!fresh) r.crook = { line: made.line, uses: 1 };
  return made.line;
}
/**
 * A second wallet to pass the money through, on a line registered against a Ghana Card lent for the
 * purpose. Wallets with medium KYC are used a few times; a small one (minimum KYC) is used once.
 * Not getting one does not stop the fraud.
 */
async function accomplice(inc: Incident, tier: "medium" | "minimum"): Promise<Line | undefined> {
  const r = inc.r;
  const usable = tier === "medium" ? r.mules.filter((m) => m.uses < 5) : [];
  if (usable.length >= 3 || (usable.length && inc.rng.chance(0.6))) {
    const m = inc.rng.pick(usable);
    m.uses++;
    return m.line;
  }
  // One Ghana Card can hold ten numbers; a lender's card is used for eight, then another is found.
  if (!r.lender || r.lender.held >= 8) r.lender = { person: await newPerson(inc), held: 0 };
  r.lender.held++;
  const made = await newLine(inc, "An accomplice", { person: r.lender.person, tier, careless: true });
  if (made.line && tier === "medium") r.mules.push({ line: made.line, uses: 1 });
  if (made.line) return made.line;
  if (usable.length) return inc.rng.pick(usable).line;
}
/** A merchant account set up to take payments for nothing. */
async function fakeShop(inc: Incident): Promise<Line | undefined> {
  const r = inc.r;
  if (r.shop) return r.shop;
  const w = inc.w;
  const person = await newPerson(inc);
  const telco = inc.rng.pick(TELCOS);
  const all = points(w, telco);
  if (!all.length) throw new Void(`There is no SIM registration point on ${TELCO_INFO[telco].name}.`);
  await quiet(r, () => {
    if (count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", telco) < 3) telcoOps.generateSims(w, telco, 20);
  });
  const reg = await attempt(inc, "The fraudster registers a business line", () => telcoOps.registerSim(w, telco, all[all.length - 1], { card: person.ghana_card, fingerprint: person.fingerprint }));
  if (!reg.value) return void inc.end("stopped", "The fraudster could not register a line for a fake shop", reg.stop);
  const msisdn = reg.value.sim.msisdn;
  const name = `${inc.rng.pick(["QuickBuy Online", "GH Best Deals", "Flash Gadgets", "Royal Imports", "Smart Shoppers"])} ${inc.rng.int(2, 99)}`;
  const shop = await attempt(inc, "The fraudster signs up as a merchant", () => telcoOps.onboardMerchant(w, telco, { msisdn, name, category: "Online", town: person.town, pin: inc.rng.digits(4) }));
  if (!shop.value) return void inc.end("stopped", "The fraudster could not sign up a fake shop", shop.stop);
  inc.add("The fraudster signs up as a merchant", `${name} can now take payments`);
  r.used.add(msisdn);
  return (r.shop = lineOf(w, msisdn));
}

// ---------- the parts incidents are made of ----------

async function text(inc: Incident, what: string, from: { msisdn: string }, to: Line, body: string): Promise<{ state: "delivered" | "warned" | "blocked"; seen?: Seen }> {
  const a = await attempt(inc, what, () => sendText(inc.w, { from: from.msisdn, to: to.msisdn, text: body }));
  if (a.stop) {
    if (a.value) inc.add(what, "Not delivered", a.stop);
    return { state: "blocked", seen: a.stop };
  }
  inc.add(what, a.warn ? "Delivered with a warning label" : "Delivered", a.warn);
  return { state: a.warn ? "warned" : "delivered", seen: a.warn };
}
async function call(inc: Incident, what: string, from: { msisdn: string }, to: Line): Promise<{ state: "connected" | "warned" | "blocked"; seen?: Seen; id?: string }> {
  const a = await attempt(inc, what, () => scriptedCall(inc.w, { from: from.msisdn, to: to.msisdn }));
  if (!a.value?.connected) {
    if (a.value) inc.add(what, "The call did not go through", a.stop);
    return { state: "blocked", seen: a.stop };
  }
  inc.add(what, a.warn ? "Rang with a warning on the screen" : "Answered", a.warn);
  return { state: a.warn ? "warned" : "connected", seen: a.warn, id: a.value.id };
}
const hangUp = (inc: Incident, id: string | undefined) => (id ? quiet(inc.r, () => scriptedCallEnd(inc.w, id, inc.rng.int(180, 600))) : Promise.resolve());

/** Opens the mobile money menu on a line. `careful` is true when the person holding the phone is the victim or an honest customer. */
async function menu(inc: Incident, who: string, line: Line, careful: boolean): Promise<"open" | "noticed" | "closed"> {
  const w = inc.w;
  const what = `${who} opens the mobile money menu`;
  const a = await attempt(inc, what, () => {
    const reply = ussd(w, { msisdn: line.msisdn, input: getConfig(w.db, `telco.${line.telco}`).menu.shortcode });
    if (reply.sessionId) w.ussd.delete(reply.sessionId);
    return reply;
  });
  if (a.stop) {
    if (a.value) inc.add(what, "The menu would not open", a.stop);
    if (inc.kind === "fraud") inc.end("stopped", "The mobile money menu would not open", a.stop);
    return "closed";
  }
  if (!a.warn) return "open";
  inc.add(what, "A notice was shown first", a.warn);
  if (inc.kind === "fraud" && careful && inc.rng.chance(REACTIONS.noticeAtMenu)) {
    inc.end("stopped", "The victim read the notice before the menu and stopped", a.warn);
    return "closed";
  }
  return "noticed";
}

const pause = (inc: Incident, from: Line, toId: string) => inc.w.cooldowns.set(`${from.id}>${toId}`, Date.now() - 1);

/** A payment made by a victim, who may be talked out of it by a warning or a pause. */
async function victimPays(inc: Incident, what: string, from: Line, toId: string, pay: (acknowledged: boolean) => Receipt, retry = true): Promise<boolean> {
  let a = await attempt(inc, what, () => pay(false));
  if (a.confirm) {
    if (inc.rng.chance(REACTIONS.warningAtPayment)) return (inc.end("stopped", "The victim read the warning and cancelled the payment", a.warn), false);
    inc.add(what, "The victim continued after the warning");
    a = await attempt(inc, what, () => pay(true));
  }
  if (a.stop?.decision === "delay" && retry) {
    if (inc.rng.chance(REACTIONS.afterPause)) return (inc.end("stopped", "The payment was paused, and the victim did not try again", a.stop), false);
    inc.add(what, "The victim tried again after the pause");
    pause(inc, from, toId);
    a = await attempt(inc, what, () => pay(false));
    if (a.confirm) a = await attempt(inc, what, () => pay(true));
  }
  if (a.stop || a.confirm) return (inc.end("stopped", "The payment was blocked", a.stop ?? a.warn), false);
  inc.add(what, "Paid");
  return true;
}
/** A payment made by the fraudster or an accomplice: a warning does not deter them, and they wait out a pause. */
async function crookPays(inc: Incident, what: string, from: Line, toId: string, pay: (acknowledged: boolean) => Receipt): Promise<Seen | undefined> {
  let a = await attempt(inc, what, () => pay(false));
  if (a.confirm) {
    inc.add(what, "The warning was ignored");
    a = await attempt(inc, what, () => pay(true));
  }
  if (a.stop?.decision === "delay") {
    inc.add(what, "Tried again after the pause");
    pause(inc, from, toId);
    a = await attempt(inc, what, () => pay(false));
    if (a.confirm) a = await attempt(inc, what, () => pay(true));
  }
  if (a.stop || a.confirm) return a.stop ?? a.warn;
  inc.add(what, "Done");
}

const feeOf = (w: World, kind: "p2p_onnet" | "p2p_offnet" | "cashout", telco: Telco, amount: number) => feeFor(getConfig(w.db, `telco.${telco}`).fees[kind], amount);
/** What a wallet can actually send on, after the fee. */
function sendable(w: World, from: Line, toTelco: Telco | undefined, amount: number, kind: "p2p" | "cashout" = "p2p") {
  const bal = lineOf(w, from.msisdn).balance;
  const fee = feeOf(w, kind === "cashout" ? "cashout" : toTelco && toTelco !== from.telco ? "p2p_offnet" : "p2p_onnet", from.telco, Math.min(amount, bal));
  return Math.max(0, Math.floor(Math.min(amount, bal - fee - 100) / 100) * 100);
}
const p2p = (w: World, from: Line, to: Line, amount: number, reference = "", channel: "ussd" | "api" = "ussd") => (acknowledged: boolean) =>
  walletPay(w, { type: "p2p", channel, from: from.id, to: to.id, amount, pin: from.pin, reference, acknowledged });

/** Cash at an agent: the agent sends a withdrawal request, the holder of the line approves it. */
async function cashOut(inc: Incident, who: string, holder: Line, amount: number): Promise<void> {
  const w = inc.w;
  const give = Math.floor(sendable(w, holder, undefined, amount, "cashout") / 100);
  if (give < 5) return void inc.end("contained", "The money never reached a wallet it could be withdrawn from");
  const agent = agentOn(inc, holder.telco, give * 100);
  await quiet(inc.r, () => {
    // An agent short of cash for this withdrawal fetches more.
    if (agent.cash < give * 100) w.db.prepare("UPDATE momo_agents SET cash = cash + ? WHERE code = ?").run(give * 100 + ghs(2000), agent.code);
  });
  const what = `${who} withdraws the money as cash at an agent`;
  const blocked = await takeCash(inc, what, holder, agent, give);
  if (blocked) return void inc.end("contained", "The cash-out was refused, so the money is still in the system", blocked);
  inc.lost += give * 100;
}
/**
 * A withdrawal at an agent, done the way the line's network does it: the agent sends a request and the
 * holder of the line allows it (MTN), or the holder starts it with the agent's number (Telecel, AT).
 * Returns what stopped it, if anything did.
 */
async function takeCash(inc: Incident, what: string, holder: Line, agent: { code: string; id: string }, give: number): Promise<Seen | undefined> {
  const w = inc.w;
  if (telcoOps.cashOutMode(w, holder.telco) === "customer_starts")
    return crookPays(inc, what, holder, agent.id, (acknowledged) => walletPay(w, { type: "cashout", channel: "ussd", from: holder.id, to: agent.id, amount: give * 100, pin: holder.pin, acknowledged }));
  const req = await attempt(inc, what, () => telcoOps.agentRequestCashOut(w, holder.telco, agent.code, { msisdn: holder.msisdn, amount: give, card: holder.card }));
  if (!req.value) return req.stop ?? { key: "", institution: holder.telco, point: "payment.request", decision: "reject" };
  return crookPays(inc, what, holder, agent.id, (ack) => approve(w, (req.value as ApprovalRow).ref, holder.pin, ack));
}

/** After the victim's money has arrived: sometimes through a second wallet, then out as cash. */
async function moveOn(inc: Incident, holder: Line, amount: number, hops = inc.rng.chance(0.6) ? 1 : 0): Promise<void> {
  const w = inc.w;
  let from = holder, left = amount;
  for (let i = 0; i < hops; i++) {
    const next = await accomplice(inc, "medium");
    if (!next || next.msisdn === from.msisdn) break;
    const send = sendable(w, from, next.telco, left);
    if (send < 500) break;
    const blocked = await crookPays(inc, "The fraudster moves the money to another wallet", from, next.id, p2p(w, from, next, send, "", from.tier === "enhanced" ? "api" : "ussd"));
    if (blocked) return void inc.end("contained", "The money was blocked while being moved on, so it is still in the fraudster's wallet", blocked);
    [from, left] = [next, send];
  }
  await cashOut(inc, from === holder ? "The fraudster" : "The accomplice", from, left);
}

const fakeName = (rng: Rng) => `${rng.pick(["KWAKU", "ABENA", "YAW", "AKUA", "KOFI", "ESI"])} ${rng.pick(["ADDO", "OWUSU", "MENSAH", "BOATENG", "ASANTE"])}`;

/** The pattern most scams follow: reach the victim by text, by call or both, and have them send the money themselves. */
async function lured(inc: Incident, o: { amounts: number[]; reference: string; sms?: (amount: number, crook: Line, victim: Line) => string; phone?: boolean; hops?: number }) {
  const w = inc.w;
  const crook = await fraudster(inc);
  if (!crook) return;
  const amount = ghs(inc.rng.pick(o.amounts));
  const victim = customer(inc, amount + ghs(30), amount > ghs(1200) ? "AND x.kyc_tier != 'minimum'" : "");
  inc.who = victim.msisdn;
  inc.atRisk = amount;
  let reached = false, last: Seen | undefined, callId: string | undefined;
  if (o.sms) {
    const t = await text(inc, "The fraudster texts the victim", crook, victim, o.sms(amount, crook, victim));
    last = t.seen ?? last;
    if (t.state !== "blocked") reached = true;
    if (t.state === "warned" && inc.rng.chance(REACTIONS.labelOnText)) return inc.end("stopped", "The victim saw the warning on the text and did not respond", t.seen);
  }
  if (o.phone) {
    const c = await call(inc, "The fraudster calls the victim", crook, victim);
    last = c.seen ?? last;
    callId = c.id;
    if (c.state !== "blocked") reached = true;
    if (c.state === "warned" && inc.rng.chance(REACTIONS.labelOnCall)) {
      await hangUp(inc, callId);
      return inc.end("stopped", "The victim saw the warning on the incoming call and hung up", c.seen);
    }
  }
  if (!reached) return inc.end("stopped", "The fraudster never reached the victim", last);
  try {
    if ((await menu(inc, "The victim", victim, true)) === "closed") return;
    if (!(await victimPays(inc, "The victim sends the money", victim, crook.id, p2p(w, victim, crook, amount, o.reference)))) return;
  } finally {
    await hangUp(inc, callId);
  }
  inc.paid = amount;
  await moveOn(inc, crook, amount, o.hops);
}

/** Someone other than the owner empties a wallet they have got control of. */
async function drain(inc: Incident, victim: Line, to: Line, amount: number): Promise<boolean> {
  const w = inc.w;
  const send = sendable(w, victim, to.telco, amount);
  inc.atRisk = send;
  if ((await menu(inc, "The fraudster", victim, false)) === "closed") return false;
  const blocked = await crookPays(inc, "The fraudster empties the victim's wallet", victim, to.id, p2p(w, victim, to, send));
  if (blocked) return (inc.end("stopped", "The transfer out of the victim's wallet was blocked", blocked), false);
  inc.paid = send;
  return true;
}
function bankVictim(inc: Incident, min: number) {
  const rows = inc.w.db.prepare("SELECT id, bank, account_no, balance FROM bank_accounts WHERE kind = 'personal' AND status = 'active' AND person_id IS NOT NULL AND balance >= ? ORDER BY id LIMIT 400").all(min) as { id: string; bank: string; account_no: string; balance: number }[];
  const free = rows.filter((a) => !inc.r.used.has(a.account_no));
  if (!free.length) throw new Void("There is no bank account with enough money in it.");
  const a = inc.rng.pick(free);
  inc.r.used.add(a.account_no);
  return a;
}

// ---------- the kinds of fraud ----------

const PLAY: Record<string, (inc: Incident) => Promise<void>> = {
  reversal_scam: (inc) =>
    lured(inc, {
      amounts: [150, 200, 300, 450, 500, 650, 800],
      reference: "reversal",
      phone: true,
      sms: (amount, crook, victim) => `Payment received for GHS ${cedis(amount)} from ${fakeName(inc.rng)} ${crook.msisdn}. Current Balance: GHS ${cedis(victim.balance + amount)}. Available Balance: GHS ${cedis(victim.balance + amount)}. Reference: school fees. Transaction ID: ${inc.rng.int(30000000000, 49999999999)}`,
    }),
  relative_impersonation: (inc) =>
    lured(inc, {
      amounts: [200, 300, 350, 500, 700],
      reference: "hospital",
      sms: (amount) => `${inc.rng.pick(["Ma", "Dad", "Auntie", "Bro", "Sis"])} it's me, my phone fell in water so I'm using my friend's number. I'm at the hospital and they want GHS ${cedis(amount)} before they treat me. Pls send to this number now, I will explain.`,
    }),
  fake_promo: (inc) =>
    lured(inc, {
      amounts: [50, 80, 100, 150],
      reference: "promo fee",
      hops: 0,
      sms: (amount, crook, victim) => `CONGRATULATIONS! Your number has won GHS ${inc.rng.pick([2000, 5000, 10000])} in the ${TELCO_INFO[victim.telco].wallet} Yɛnkɔ Promo. To claim, send processing fee of GHS ${cedis(amount)} to our agent ${crook.msisdn}. Offer ends today.`,
    }),

  async pin_phishing(inc) {
    const crook = await fraudster(inc);
    if (!crook) return;
    const victim = customer(inc, ghs(300), "AND x.kyc_tier != 'minimum'");
    inc.who = victim.msisdn;
    inc.atRisk = Math.min(Math.floor(victim.balance * 0.8), ghs(2000));
    // The caller says they are customer service and that the wallet will be blocked unless the PIN is confirmed.
    const c = await call(inc, "The fraudster calls the victim, posing as customer service", crook, victim);
    if (c.state === "blocked") return inc.end("stopped", "The fraudster's call never reached the victim", c.seen);
    if (c.state === "warned" && inc.rng.chance(REACTIONS.labelOnCall)) {
      await hangUp(inc, c.id);
      return inc.end("stopped", "The victim saw the warning on the incoming call and hung up", c.seen);
    }
    let ok = false;
    try {
      inc.add("The victim gives the caller their PIN", "The fraudster now has the PIN");
      ok = await drain(inc, victim, crook, inc.atRisk);
    } finally {
      await hangUp(inc, c.id);
    }
    if (ok) await moveOn(inc, crook, inc.paid);
  },

  async sim_swap(inc) {
    const w = inc.w;
    const crook = await fraudster(inc);
    if (!crook) return;
    const victim = customer(inc, ghs(400), "AND x.kyc_tier != 'minimum'");
    inc.who = victim.msisdn;
    inc.atRisk = Math.min(Math.floor(victim.balance * 0.8), ghs(2000));
    const all = points(w, victim.telco);
    if (!all.length) throw new Void(`There is no SIM registration point on ${TELCO_INFO[victim.telco].name}.`);
    // A day earlier, so that the pause the network puts on a replaced SIM has run out by now.
    const then = Date.now() - 25 * HOUR;
    const swap = await attempt(inc, "The fraudster has the victim's number moved to a new SIM", () => telcoOps.swapSim(w, victim.telco, all[all.length - 1], { msisdn: victim.msisdn, card: victim.card, fingerprint: victim.fingerprint }), then);
    if (swap.stop) return inc.end("stopped", "The SIM replacement was refused", swap.stop);
    inc.add("The fraudster has the victim's number moved to a new SIM", "The number now rings on the fraudster's SIM");
    const reset = await attempt(inc, "The fraudster has the wallet PIN reset", () => telcoOps.resetPin(w, victim.telco, all[all.length - 1], { msisdn: victim.msisdn, card: victim.card, fingerprint: victim.fingerprint }), then + 20 * MINUTE);
    if (reset.stop) return inc.end("stopped", "The PIN reset was refused, so the wallet could not be opened", reset.stop);
    inc.add("The fraudster has the wallet PIN reset", "A new PIN was texted to the fraudster's SIM");
    if (await drain(inc, lineOf(w, victim.msisdn), crook, inc.atRisk)) await moveOn(inc, crook, inc.paid);
  },

  async agent_fraud(inc) {
    const w = inc.w;
    if (inc.rng.chance(0.5)) {
      // A caller claiming to be agent support has an agent send float "for reconciliation".
      const crook = await fraudster(inc);
      if (!crook) return;
      const telco = inc.rng.pick(TELCOS);
      const amount = ghs(inc.rng.pick([500, 800, 1000, 1500]));
      const found = agentOn(inc, telco, 0);
      const agent = lineOf(w, found.msisdn);
      if (agent.balance < amount + ghs(100)) throw new Void("The agent chosen does not have enough float.");
      inc.who = agent.msisdn;
      inc.atRisk = amount;
      const c = await call(inc, "The fraudster calls an agent, posing as agent support", crook, agent);
      if (c.state === "blocked") return inc.end("stopped", "The fraudster's call never reached the agent", c.seen);
      if (c.state === "warned" && inc.rng.chance(REACTIONS.labelOnCall)) {
        await hangUp(inc, c.id);
        return inc.end("stopped", "The agent saw the warning on the incoming call and hung up", c.seen);
      }
      let paid = false;
      try {
        paid = await victimPays(inc, "The agent sends float to the caller's number", agent, crook.id, p2p(w, agent, crook, amount, "float reconciliation"));
      } finally {
        await hangUp(inc, c.id);
      }
      if (!paid) return;
      inc.paid = amount;
      return moveOn(inc, crook, amount);
    }
    // A wallet the fraudster controls is cashed out at an agent who asks no questions.
    const victim = customer(inc, ghs(400));
    inc.who = victim.msisdn;
    const give = Math.floor(sendable(w, victim, undefined, Math.min(Math.floor(victim.balance * 0.7), ghs(1500)), "cashout") / 100);
    inc.atRisk = give * 100;
    const agent = agentOn(inc, victim.telco, give * 100);
    await quiet(inc.r, () => {
      if (agent.cash < give * 100) w.db.prepare("UPDATE momo_agents SET cash = cash + ? WHERE code = ?").run(give * 100 + ghs(2000), agent.code);
    });
    const blocked = await takeCash(inc, "A complicit agent withdraws from the victim's wallet", victim, agent, give);
    if (blocked) return inc.end("stopped", "The withdrawal was blocked", blocked);
    inc.paid = inc.lost = give * 100;
  },

  async mule_chain(inc) {
    const w = inc.w;
    const crook = await fraudster(inc);
    if (!crook) return;
    const amount = ghs(inc.rng.pick([800, 1200, 1800, 2500]));
    const acct = bankVictim(inc, amount + ghs(100));
    inc.who = `${acct.bank} account ${acct.account_no}`;
    inc.atRisk = amount;
    const take = await attempt(inc, "Money is taken from the victim's bank account into the fraudster's wallet", () => bankToWallet(w, { bank: acct.bank, fromAccount: acct.id, msisdn: crook.msisdn, amount }));
    if (!take.value) return inc.end("stopped", "The transfer out of the bank account was blocked", take.stop);
    inc.add("Money is taken from the victim's bank account into the fraudster's wallet", "Received");
    inc.paid = amount;
    await moveOn(inc, crook, amount, 2);
  },

  async rtp_abuse(inc) {
    const w = inc.w;
    const shop = await fakeShop(inc);
    if (!shop) return;
    const crook = await fraudster(inc);
    if (!crook) return;
    const amount = ghs(inc.rng.pick([120, 250, 300, 400, 600]));
    const victim = customer(inc, amount + ghs(30));
    inc.who = victim.msisdn;
    inc.atRisk = amount;
    const t = await text(inc, "The fraudster texts the victim, posing as a buyer", crook, victim, `Hello, I am sending you GHS ${cedis(amount)} for the item you posted. You will get a prompt; approve it to receive the money.`);
    if (t.state === "blocked") return inc.end("stopped", "The fraudster's text never reached the victim", t.seen);
    if (t.state === "warned" && inc.rng.chance(REACTIONS.labelOnText)) return inc.end("stopped", "The victim saw the warning on the text and did not respond", t.seen);
    const what = "The fake shop sends the victim a payment request";
    const req = await attempt(inc, what, () => createApproval(w, { kind: "rtp", payeeWallet: shop.id, payerMsisdn: victim.msisdn, amount, payerMessage: "Payment for item" }));
    if (req.stop || req.value?.status !== "PENDING") return inc.end("stopped", "The payment request never reached the victim", req.stop);
    inc.add(what, "The prompt appeared on the victim's phone");
    const ref = req.value.ref;
    if (!(await victimPays(inc, "The victim approves the prompt", victim, shop.id, (ack) => approve(w, ref, victim.pin, ack), false))) {
      await quiet(inc.r, () => {
        try {
          rejectApproval(w, ref, "Rejected by payer");
        } catch {}
      });
      return;
    }
    inc.paid = amount;
    await moveOn(inc, shop, amount, 1);
  },

  async fake_merchant(inc) {
    const w = inc.w;
    const shop = await fakeShop(inc);
    if (!shop) return;
    const amount = ghs(inc.rng.pick([60, 120, 180, 250, 400]));
    const victim = customer(inc, amount + ghs(30));
    inc.who = victim.msisdn;
    inc.atRisk = amount;
    if ((await menu(inc, "The victim", victim, true)) === "closed") return;
    const pay = (acknowledged: boolean) => walletPay(w, { type: "merchant", channel: "ussd", from: victim.id, to: shop.id, amount, pin: victim.pin, reference: "order", acknowledged });
    if (!(await victimPays(inc, "The victim pays the shop for goods that will never arrive", victim, shop.id, pay))) return;
    inc.paid = amount;
    await moveOn(inc, shop, amount, 1);
  },

  async limit_splitting(inc) {
    const w = inc.w;
    // A wallet of its own for this, since the sum is large.
    const hub = await fraudster(inc, true);
    if (!hub) return;
    const amount = ghs(inc.rng.pick([6000, 7500, 9000]));
    const acct = bankVictim(inc, amount + ghs(100));
    inc.who = `${acct.bank} account ${acct.account_no}`;
    inc.atRisk = amount;
    const take = await attempt(inc, "A large sum is taken from the victim's bank account into one wallet", () => bankToWallet(w, { bank: acct.bank, fromAccount: acct.id, msisdn: hub.msisdn, amount }));
    if (!take.value) return inc.end("stopped", "The transfer out of the bank account was blocked", take.stop);
    inc.add("A large sum is taken from the victim's bank account into one wallet", "Received");
    inc.paid = amount;
    // Split into pieces that each fit under the daily limit of a wallet with minimum KYC.
    let lastBlock: Seen | undefined;
    for (let i = 0; i < 3; i++) {
      const to = await accomplice(inc, "minimum");
      const piece = sendable(w, hub, to?.telco, ghs(inc.rng.int(15, 28) * 100));
      if (!to || piece < ghs(100)) break;
      const blocked = await crookPays(inc, "A piece under the daily limit is sent to a small wallet", hub, to.id, p2p(w, hub, to, piece));
      if (blocked) {
        lastBlock = blocked;
        continue;
      }
      const before = inc.ended;
      await cashOut(inc, "The accomplice", to, piece);
      // One piece being held does not end the incident: the others may still get out.
      if (!before && inc.ended) {
        lastBlock = inc.ended.seen;
        inc.ended = undefined;
      }
    }
    if (!inc.lost) inc.end("contained", "None of the money got out as cash: it is still in the wallets it was sent to", lastBlock);
  },

  async pin_guessing(inc) {
    const w = inc.w;
    // An ordinary customer joins, and like many people chooses the end of their number as their PIN.
    const person = await newPerson(inc, 20, 60);
    const telco = inc.rng.pick(TELCOS);
    const all = points(w, telco);
    if (!all.length) throw new Void(`There is no SIM registration point on ${TELCO_INFO[telco].name}.`);
    await quiet(inc.r, () => {
      if (count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", telco) < 3) telcoOps.generateSims(w, telco, 20);
    });
    const reg = await attempt(inc, "A new customer registers a SIM", () => telcoOps.registerSim(w, telco, all[0], { card: person.ghana_card, fingerprint: person.fingerprint }));
    if (!reg.value) throw new Void("The customer's SIM registration was refused.");
    const msisdn = reg.value.sim.msisdn;
    inc.who = msisdn;
    inc.r.used.add(msisdn);
    const guessable = [msisdn.slice(-4), person.dob.slice(0, 4)];
    let pin = "", guard: Seen | undefined;
    for (const choice of [...guessable, inc.rng.digits(4).replace(/^(\d)\1{3}$/, "2749")]) {
      const what = guessable.includes(choice) ? `The customer chooses ${choice === guessable[0] ? "the end of their number" : "their year of birth"} as their PIN` : "The customer chooses a PIN nobody could guess";
      const a = await attempt(inc, what, () => telcoOps.pinProblem(w, msisdn, choice, "new_wallet"));
      if (a.stop) {
        if (a.value) inc.add(what, "Refused: they have to choose another", a.stop);
        guard ??= a.stop;
        continue;
      }
      inc.add(what, "Accepted");
      pin = choice;
      break;
    }
    if (!pin) throw new Void("Every PIN the customer tried was refused.");
    const agent = agentOn(inc, telco, 0);
    const amount = ghs(inc.rng.pick([600, 900, 1200, 1500]));
    inc.atRisk = amount;
    // Opening the wallet and putting money in it are not part of the fraud, so no service is asked.
    await quiet(inc.r, () => {
      telcoOps.agentRegisterWallet(w, telco, agent.code, { msisdn, card: person.ghana_card, fingerprint: person.fingerprint, pin });
      if (agent.balance < amount + ghs(100)) bankToWallet(w, { bank: "gcb", msisdn: agent.msisdn, amount: ghs(20000), reference: "float" });
      telcoOps.agentCashIn(w, telco, agent.code, { msisdn, amount: amount / 100, pin: agent.pin });
    });
    inc.add("The customer opens a wallet and puts money in it", `GHS ${cedis(amount)} in the wallet`);
    const crook = await fraudster(inc);
    if (!crook) return;
    inc.add("The phone is stolen", "The thief has the phone, and tries the PINs people usually choose");
    const victim = lineOf(w, msisdn);
    const send = sendable(w, victim, crook.telco, amount);
    for (const guess of [...guessable, "1234"]) {
      const what = `The thief tries ${guess === guessable[0] ? "the end of the number" : guess === guessable[1] ? "the year of birth" : "1234"} as the PIN`;
      const d = await step(inc.r, () => walletPay(w, { type: "p2p", channel: "ussd", from: victim.id, to: crook.id, amount: send, pin: guess }));
      if (!d.ok && /^Wrong PIN|locked/.test(d.error.message) && !worst(d.seen) && !(d.error instanceof Confirm)) {
        inc.add(what, d.error.message);
        if (/locked/.test(d.error.message)) return inc.end("stopped", "The thief could not guess the PIN, and the wallet locked itself", guard);
        continue;
      }
      // The PIN was right. From here it is a payment like any other.
      inc.add(what, "Correct");
      const blocked = d.ok ? undefined : await crookPays(inc, "The thief sends the money to their own wallet", victim, crook.id, p2p(w, { ...victim, pin: guess }, crook, send));
      if (blocked) return inc.end("stopped", "The transfer out of the victim's wallet was blocked", blocked);
      if (d.ok) inc.add("The thief sends the money to their own wallet", "Done");
      inc.paid = send;
      return moveOn(inc, crook, send);
    }
    inc.end("stopped", "The thief could not guess the PIN", guard);
  },
};

// ---------- ordinary activity ----------

const ORDINARY_TEXTS = [
  "Good morning, how are you?", "Are you coming for the meeting today?", "I sent the 50 cedis this morning, check your MoMo.", "Please send me 20 cedis for lunch, I will pay you back on Friday.",
  "I mistakenly sent 30 cedis to you instead of Kofi, please send it back when you see this. Sorry.", "The landlord wants the rent by Friday.", "Mum says you should call her.", "My phone fell and the screen is broken, I am using this one for now.",
  "Thanks for the transfer, I have received it.", "I am at the hospital with Auntie, nothing serious.",
];

/** An honest customer's payment: a warning usually does not put them off, a block or a pause does. */
async function honestPays(inc: Incident, what: string, pay: (acknowledged: boolean) => Receipt, slowed: boolean) {
  let a = await attempt(inc, what, () => pay(false));
  if (a.confirm) {
    if (inc.rng.chance(REACTIONS.ordinaryPutOff)) return inc.end("blocked", "The customer was put off by a warning and gave up", a.warn);
    a = await attempt(inc, what, () => pay(true));
    slowed = true;
    if (!a.stop && !a.confirm) return inc.end("slowed", "Went through after a warning", a.warn);
  }
  if (a.stop || a.confirm) return inc.end("blocked", a.stop?.decision === "delay" ? "The customer's payment was paused" : "The customer's payment was blocked", a.stop ?? a.warn);
  inc.end(slowed ? "slowed" : "fine", slowed ? "Went through after a notice" : "Went through");
}

const ORDINARY: [string, number, (inc: Incident) => Promise<void>][] = [
  ["A text between two customers", 4, async (inc) => {
    const a = customer(inc, 0), b = customer(inc, 0);
    inc.who = b.msisdn;
    const t = await text(inc, "One customer texts another", a, b, inc.rng.pick(ORDINARY_TEXTS));
    inc.end(t.state === "blocked" ? "blocked" : t.state === "warned" ? "slowed" : "fine", t.state === "blocked" ? "An honest text was not delivered" : t.state === "warned" ? "An honest text arrived with a warning label" : "Delivered", t.seen);
  }],
  ["A call between two customers", 3, async (inc) => {
    const a = customer(inc, 0), b = customer(inc, 0);
    inc.who = b.msisdn;
    const c = await call(inc, "One customer calls another", a, b);
    await hangUp(inc, c.id);
    inc.end(c.state === "blocked" ? "blocked" : c.state === "warned" ? "slowed" : "fine", c.state === "blocked" ? "An honest call did not go through" : c.state === "warned" ? "An honest call rang with a warning" : "Answered", c.seen);
  }],
  ["A payment to another customer", 6, async (inc) => {
    const w = inc.w;
    const amount = ghs(inc.rng.pick([10, 20, 30, 50, 80, 100, 150, 200, 300]));
    const from = customer(inc, amount + ghs(20));
    inc.who = from.msisdn;
    // Mostly to someone they have paid before, sometimes to someone new, sometimes while on the phone with them.
    const known = w.db.prepare(`${LINE_SQL} WHERE x.status = 'active' AND x.owner_type = 'person' AND x.id IN (SELECT to_wallet FROM txns WHERE from_wallet = ? AND type = 'p2p' AND status = 'success') LIMIT 5`).all(from.id) as unknown as Line[];
    const to = known.length && inc.rng.chance(0.7) ? inc.rng.pick(known) : customer(inc, 0);
    const onCall = inc.rng.chance(0.2) ? await call(inc, "The customer is on the phone with the person they are paying", to, from) : undefined;
    try {
      const m = await menu(inc, "The customer", from, true);
      if (m === "closed") return inc.end("blocked", "The customer could not open the mobile money menu", inc.trail.at(-1) && { key: "", institution: from.telco, point: "menu.open", decision: "reject", by: inc.trail.at(-1)!.by });
      await honestPays(inc, "The customer sends money", p2p(w, from, to, amount, inc.rng.pick(["", "food", "rent", "thanks"])), m === "noticed");
    } finally {
      await hangUp(inc, onCall?.id);
    }
  }],
  ["A payment to a shop", 3, async (inc) => {
    const w = inc.w;
    const amount = ghs(inc.rng.pick([15, 25, 40, 60, 90, 140]));
    const from = customer(inc, amount + ghs(20));
    inc.who = from.msisdn;
    const shop = w.db.prepare("SELECT x.id FROM wallets x WHERE x.owner_type = 'merchant' AND x.status = 'active' AND x.created_at < ? ORDER BY x.id LIMIT 200").all(Date.now() - 7 * 24 * HOUR) as { id: string }[];
    if (!shop.length) throw new Void("There is no established merchant.");
    const to = inc.rng.pick(shop);
    await honestPays(inc, "The customer pays a shop", (acknowledged) => walletPay(w, { type: "merchant", channel: "ussd", from: from.id, to: to.id, amount, pin: from.pin, reference: "goods", acknowledged }), false);
  }],
  ["A cash withdrawal at an agent", 3, async (inc) => {
    const w = inc.w;
    const from = customer(inc, ghs(120));
    inc.who = from.msisdn;
    const give = Math.floor(sendable(w, from, undefined, Math.min(Math.floor(from.balance * 0.5), ghs(500)), "cashout") / 100);
    const agent = agentOn(inc, from.telco, give * 100);
    await quiet(inc.r, () => {
      if (agent.cash < give * 100) w.db.prepare("UPDATE momo_agents SET cash = cash + ? WHERE code = ?").run(ghs(5000), agent.code);
    });
    if (telcoOps.cashOutMode(w, from.telco) === "customer_starts")
      return honestPays(inc, "The customer withdraws cash at an agent", (acknowledged) => walletPay(w, { type: "cashout", channel: "ussd", from: from.id, to: agent.id, amount: give * 100, pin: from.pin, acknowledged }), false);
    const req = await attempt(inc, "The customer asks an agent for cash", () => telcoOps.agentRequestCashOut(w, from.telco, agent.code, { msisdn: from.msisdn, amount: give, card: from.card }));
    if (!req.value) return inc.end("blocked", "The customer's withdrawal was refused", req.stop);
    await honestPays(inc, "The customer approves the withdrawal", (ack) => approve(w, (req.value as ApprovalRow).ref, from.pin, ack), false);
  }],
  ["A genuine SIM replacement", 2, async (inc) => {
    const w = inc.w;
    const v = customer(inc, 0);
    inc.who = v.msisdn;
    const a = await attempt(inc, "A customer who lost their phone has their SIM replaced", () => telcoOps.swapSim(w, v.telco, points(w, v.telco)[0], { msisdn: v.msisdn, card: v.card, fingerprint: v.fingerprint }));
    inc.end(a.stop ? "blocked" : "fine", a.stop ? "A genuine SIM replacement was refused" : "Replaced", a.stop);
  }],
  ["A new customer joining", 3, async (inc) => {
    const w = inc.w;
    const person = await newPerson(inc, 18, 65);
    const telco = inc.rng.pick(TELCOS);
    const all = points(w, telco);
    if (!all.length) throw new Void(`There is no SIM registration point on ${TELCO_INFO[telco].name}.`);
    await quiet(inc.r, () => {
      if (count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", telco) < 3) telcoOps.generateSims(w, telco, 20);
    });
    const reg = await attempt(inc, "A new customer registers a SIM", () => telcoOps.registerSim(w, telco, inc.rng.pick(all), { card: person.ghana_card, fingerprint: person.fingerprint }));
    if (!reg.value) return inc.end("blocked", "An honest customer's SIM registration was refused", reg.stop);
    const msisdn = reg.value.sim.msisdn;
    inc.who = msisdn;
    inc.r.used.add(msisdn);
    // About a third of people choose the end of their number.
    let refused: Seen | undefined;
    for (const pin of [inc.rng.chance(0.34) ? msisdn.slice(-4) : inc.rng.digits(4), inc.rng.digits(4).replace(/^(\d)\1{3}$/, "2749"), "2749"]) {
      const a = await attempt(inc, "They open a wallet and choose a PIN", () => telcoOps.agentRegisterWallet(w, telco, agentOn(inc, telco, 0).code, { msisdn, card: person.ghana_card, fingerprint: person.fingerprint, pin }));
      if (a.value) return inc.end(refused ? "slowed" : "fine", refused ? "Joined, after being asked to choose another PIN" : "Joined", refused);
      if (a.stop?.point !== "pin.set") return inc.end("blocked", "An honest customer could not open a wallet", a.stop);
      refused = a.stop;
    }
    inc.end("blocked", "An honest customer could not choose a PIN", refused);
  }],
  ["A customer changing their PIN", 2, async (inc) => {
    const w = inc.w;
    const v = customer(inc, 0);
    inc.who = v.msisdn;
    const wallet = { id: v.id, msisdn: v.msisdn, telco: v.telco } as Parameters<typeof telcoOps.changePin>[1];
    const first = await attempt(inc, "A customer changes their PIN", () => telcoOps.changePin(w, wallet, inc.rng.chance(0.4) ? v.dob.slice(0, 4) : "8306"));
    if (!first.stop) return inc.end("fine", "Changed");
    const second = await attempt(inc, "They choose a different PIN", () => telcoOps.changePin(w, wallet, "7391"));
    inc.end(second.stop ? "blocked" : "slowed", second.stop ? "An honest customer could not change their PIN" : "Changed, after being asked to choose another PIN", second.stop ?? first.stop);
  }],
  ["Money moved from a bank account to the owner's wallet", 2, async (inc) => {
    const w = inc.w;
    const rows = w.db
      .prepare("SELECT a.id, a.bank, x.msisdn FROM bank_accounts a JOIN wallets x ON x.person_id = a.person_id WHERE a.kind = 'personal' AND a.status = 'active' AND a.balance >= 60000 AND x.owner_type = 'person' AND x.status = 'active' AND x.kyc_tier != 'minimum' AND x.created_at < ? ORDER BY a.id LIMIT 300")
      .all(Date.now() - 7 * 24 * HOUR) as { id: string; bank: string; msisdn: string }[];
    if (!rows.length) throw new Void("Nobody has both a bank account with money in it and a wallet.");
    const a = inc.rng.pick(rows);
    inc.who = a.msisdn;
    const t = await attempt(inc, "A customer moves money from their bank account to their own wallet", () => bankToWallet(w, { bank: a.bank, fromAccount: a.id, msisdn: a.msisdn, amount: ghs(inc.rng.pick([100, 200, 300, 500])) }));
    inc.end(t.stop ? "blocked" : "fine", t.stop ? "An honest transfer from a bank account was blocked" : "Went through", t.stop);
  }],
  ["A text from a shop to a customer", 1, async (inc) => {
    const w = inc.w;
    const shop = w.db.prepare("SELECT display_name, telco FROM wallets WHERE owner_type = 'merchant' AND status = 'active' AND created_at < ? ORDER BY id LIMIT 100").all(Date.now() - 7 * 24 * HOUR) as { display_name: string; telco: Telco }[];
    if (!shop.length) throw new Void("There is no established merchant.");
    const to = customer(inc, 0);
    inc.who = to.msisdn;
    const what = "A shop texts a customer that their order is ready";
    const a = await attempt(inc, what, () => sendAppSms(w, inc.rng.pick(shop), { to: to.msisdn, text: "Your order is ready for pickup. Thank you for shopping with us." }));
    inc.end(a.stop ? "blocked" : a.warn ? "slowed" : "fine", a.stop ? "A shop's text was not delivered" : a.warn ? "A shop's text arrived with a warning label" : "Delivered", a.stop ?? a.warn);
  }],
];

// ---------- runs ----------

export interface RunRequest {
  kinds?: unknown;
  incidents?: unknown;
  ordinary?: unknown;
  app?: unknown;
  seed?: unknown;
}

/** What has to exist before incidents can be played. */
export function readiness(w: World): string | undefined {
  if (count(w.db, "SELECT COUNT(*) AS n FROM wallets WHERE owner_type = 'person' AND status = 'active' AND balance >= 30000 AND created_at < ?", Date.now() - 7 * 24 * HOUR) < 30)
    return "The fraud simulator needs people to act as victims: at least 30 customers who have had money in their wallets for a week. Load the simulated country from your team's home page to get them.";
  for (const t of TELCOS) {
    if (!count(w.db, "SELECT COUNT(*) AS n FROM momo_agents a JOIN wallets x ON x.id = a.wallet_id WHERE x.telco = ? AND a.status = 'active'", t)) return `The fraud simulator needs a mobile money agent on ${TELCO_INFO[t].name}. Loading the simulated country provides them.`;
    if (!count(w.db, "SELECT COUNT(*) AS n FROM sim_agents WHERE telco = ? AND status = 'active'", t)) return `The fraud simulator needs a SIM registration point on ${TELCO_INFO[t].name}. Loading the simulated country provides them.`;
  }
}

export const listApps = (w: World) =>
  (w.db.prepare("SELECT * FROM fraud_apps ORDER BY created_at").all() as { id: string; name: string; url: string; kinds: string; created_at: number }[]).map((a) => ({ id: a.id, name: a.name, url: a.url, kinds: JSON.parse(a.kinds) as string[] }));

const kindsOf = (input: unknown): string[] => {
  const list = (Array.isArray(input) ? input : String(input ?? "all").split(",")).map((k) => String(k).trim()).filter(Boolean);
  if (!list.length || list.includes("all")) return Object.keys(FRAUD_KINDS);
  const unknown = list.filter((k) => !(k in FRAUD_KINDS));
  if (unknown.length) throw new SimError(`Unknown kind of fraud: ${unknown.join(", ")}. Kinds: ${Object.keys(FRAUD_KINDS).join(", ")}`);
  return [...new Set(list)];
};

/** A standalone application joins the simulator: it will be sent incidents of the kinds it is built to stop. */
export function connectApp(w: World, input: { name?: unknown; url?: unknown; kinds?: unknown }) {
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) throw new SimError("The application needs a name");
  const url = checkUrl(typeof input.url === "string" ? input.url : undefined);
  const kinds = kindsOf(input.kinds);
  const id = newId("app");
  w.db.prepare("INSERT INTO fraud_apps(id, name, url, kinds, created_at) VALUES(?,?,?,?,?)").run(id, name, url, JSON.stringify(kinds), w.now);
  audit(w, "fraud", "app", `Connected the application "${name}" to the fraud simulator`);
  return { id, name, url, kinds };
}
export function disconnectApp(w: World, id: unknown) {
  if (!w.db.prepare("DELETE FROM fraud_apps WHERE id = ?").run(String(id)).changes) throw new SimError("Application not found");
}

export const isRunning = (w: World) => running.has(w.id) && running.get(w.id)!.w === w;

/** Starts a run in the background and returns at once. The results build up in the team's console. */
export function startRun(w: World, req: RunRequest) {
  if (isRunning(w)) throw new SimError("The fraud simulator is already running in this world. Wait for it to finish, or stop it.");
  const why = readiness(w);
  if (why) throw new SimError(why);
  const app = req.app ? listApps(w).find((a) => a.id === String(req.app) || a.name === String(req.app)) : undefined;
  if (req.app && !app) throw new SimError("That application is not connected to the fraud simulator");
  const kinds = req.kinds === undefined && app ? app.kinds : kindsOf(req.kinds);
  const planned = Math.floor(Number(req.incidents ?? 20));
  if (!(planned >= 1 && planned <= 200)) throw new SimError("Choose between 1 and 200 incidents");
  const ordinary = req.ordinary === undefined ? planned : Math.floor(Number(req.ordinary));
  if (!(ordinary >= 0 && ordinary <= 400)) throw new SimError("Choose between 0 and 400 pieces of ordinary activity");
  const seed = Math.floor(Number(req.seed ?? 1)) || 1;
  const id = newId("run");
  const target = app ? app.name : "plugins";
  w.db.prepare("INSERT INTO fraud_runs(id, started_at, status, kinds, target, planned, ordinary, seed) VALUES(?,?, 'running', ?,?,?,?,?)").run(id, w.now, JSON.stringify(kinds), target, planned, ordinary, seed);
  audit(w, "fraud", "run", `Fraud simulator started: ${planned} incident(s) of ${kinds.length === Object.keys(FRAUD_KINDS).length ? "every kind" : kinds.join(", ")}, against ${app ? `the application "${app.name}"` : "the plugged-in APIs"}`);
  const r: RunCtx = { id, w, rng: new Rng(seed), app: app && { id: app.id, name: app.name, url: app.url }, stop: false, mules: [], used: new Set() };
  running.set(w.id, r);
  void execute(r, kinds, planned, ordinary);
  return { run: id, incidents: planned, ordinary, kinds, against: app ? `the application "${app.name}"` : "the APIs plugged into the institutions" };
}

export function stopRun(w: World) {
  const r = running.get(w.id);
  if (!r || r.w !== w) throw new SimError("The fraud simulator is not running");
  r.stop = true;
}

async function execute(r: RunCtx, kinds: string[], planned: number, ordinary: number) {
  const w = r.w;
  // Incidents of each kind in turn, with the ordinary activity spread among them.
  const plan: { kind: "fraud" | "ordinary"; scenario: string }[] = [];
  for (let i = 0; i < planned; i++) plan.push({ kind: "fraud", scenario: kinds[i % kinds.length] });
  for (let i = 0; i < ordinary; i++) plan.push({ kind: "ordinary", scenario: r.rng.weighted(ORDINARY, (o) => o[1])[0] });
  for (let i = plan.length - 1; i > 0; i--) {
    const j = r.rng.int(0, i);
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  const save = w.db.prepare("INSERT INTO fraud_incidents(run_id, at, kind, scenario, who, outcome, stopped_at, stopped_by, answer, at_risk, lost, summary, trail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  let note: string | undefined;
  try {
    for (const item of plan) {
      if (r.stop) break;
      let inc!: Incident;
      // An incident that could not be played for an unrelated reason (a limit reached, say) is tried again with other people.
      for (let tries = 0; tries < 3; tries++) {
        inc = new Incident(r, item.kind, item.scenario, new Rng(r.rng.int(1, 2 ** 31 - 1)));
        try {
          if (item.kind === "fraud") {
            await PLAY[item.scenario](inc);
            inc.end(inc.lost > 0 ? "through" : inc.paid > 0 ? "contained" : "stopped", inc.lost > 0 ? "The money was withdrawn as cash and is gone" : "The money did not get out");
            if (inc.lost > 0 && inc.ended!.outcome !== "through") inc.ended = { outcome: "through", summary: "Part of the money was withdrawn as cash and is gone" };
          } else {
            await ORDINARY.find((o) => o[0] === item.scenario)![2](inc);
            inc.end("fine", "Went through");
          }
          break;
        } catch (e) {
          if (!(e instanceof Void)) throw e;
          inc.ended = { outcome: "void", summary: e.message };
        }
      }
      const e = inc.ended!;
      await quiet(r, () => save.run(r.id, Date.now(), inc.kind, inc.scenario, inc.who ?? null, e.outcome, e.seen?.point ?? null, e.seen?.by ?? null, e.seen?.decision ?? null, inc.atRisk, inc.lost, e.summary, JSON.stringify(inc.trail)));
    }
  } catch (e) {
    note = (e as Error).message;
  } finally {
    if (running.get(w.id) === r) running.delete(w.id);
    try {
      w.db.prepare("UPDATE fraud_runs SET status = ?, finished_at = ?, note = ? WHERE id = ?").run(r.stop ? "stopped" : note ? "stopped" : "finished", Date.now(), note ?? null, r.id);
    } catch {
      // The world was reset or replaced while the run was going.
    }
  }
}

// ---------- results ----------

const tally = (rows: { outcome: string }[]) => rows.reduce<Record<string, number>>((t, r) => ((t[r.outcome] = (t[r.outcome] ?? 0) + 1), t), {});

/** Everything the team's console shows about the simulator: what can be run, and the results so far. */
export function fraudResults(w: World) {
  const runs = w.db.prepare("SELECT * FROM fraud_runs ORDER BY started_at DESC LIMIT 12").all() as { id: string; started_at: number; finished_at: number | null; status: string; kinds: string; target: string; planned: number; ordinary: number; note: string | null }[];
  const of = (run: string) => w.db.prepare("SELECT * FROM fraud_incidents WHERE run_id = ? ORDER BY id").all(run) as { id: number; at: number; kind: string; scenario: string; who: string | null; outcome: string; stopped_at: string | null; stopped_by: string | null; answer: string | null; at_risk: number; lost: number; summary: string; trail: string }[];
  const summarise = (run: (typeof runs)[number]) => {
    const rows = of(run.id);
    const fraud = rows.filter((r) => r.kind === "fraud" && r.outcome !== "void");
    const ordinary = rows.filter((r) => r.kind === "ordinary" && r.outcome !== "void");
    const live = run.status === "running" && isRunning(w);
    return {
      rows,
      fraud,
      ordinary,
      head: {
        id: run.id,
        startedAt: new Date(run.started_at).toISOString(),
        finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
        // A run that was going when the sandbox restarted never finished.
        status: run.status === "running" && !live ? "interrupted" : run.status,
        kinds: JSON.parse(run.kinds) as string[],
        against: run.target === "plugins" ? "The APIs plugged into the institutions" : `The application "${run.target}"`,
        planned: run.planned + run.ordinary,
        done: rows.length,
        note: run.note,
        fraud: { total: fraud.length, stopped: 0, contained: 0, through: 0, ...tally(fraud) },
        ordinary: { total: ordinary.length, fine: 0, slowed: 0, blocked: 0, ...tally(ordinary) },
        couldNotBePlayed: rows.filter((r) => r.outcome === "void").length,
        atRisk: fraud.reduce((s, r) => s + r.at_risk, 0) / 100,
        lost: fraud.reduce((s, r) => s + r.lost, 0) / 100,
      },
    };
  };
  const latest = runs.length ? summarise(runs[0]) : undefined;
  const stops = new Map<string, { step: string; by: string; answer: string; fraud: number; ordinary: number }>();
  for (const r of latest?.rows ?? []) {
    if (!r.stopped_at || r.outcome === "void" || r.outcome === "fine") continue;
    const key = `${r.stopped_at}|${r.stopped_by}|${r.answer}`;
    const s = stops.get(key) ?? { step: r.stopped_at, by: r.stopped_by ?? "", answer: r.answer ?? "", fraud: 0, ordinary: 0 };
    s[r.kind === "fraud" ? "fraud" : "ordinary"]++;
    stops.set(key, s);
  }
  return {
    kinds: Object.entries(FRAUD_KINDS).map(([id, about]) => ({ id, about })),
    apps: listApps(w),
    pluggedIn: count(w.db, "SELECT COUNT(*) AS n FROM integrations WHERE enabled = 1"),
    notReady: readiness(w) ?? null,
    running: isRunning(w),
    reactions: REACTIONS,
    latest: latest && {
      ...latest.head,
      byKind: Object.keys(FRAUD_KINDS)
        .map((k) => {
          const rows = latest.fraud.filter((r) => r.scenario === k);
          return { kind: k, stopped: 0, contained: 0, through: 0, ...tally(rows), total: rows.length };
        })
        .filter((k) => k.total),
      stops: [...stops.values()].sort((a, b) => b.fraud - a.fraud),
      incidents: latest.rows.map((r) => ({
        id: r.id, at: new Date(r.at).toISOString(), kind: r.kind, scenario: r.scenario, who: r.who, outcome: r.outcome, stoppedAt: r.stopped_at, stoppedBy: r.stopped_by, answer: r.answer,
        atRisk: r.at_risk / 100, lost: r.lost / 100, summary: r.summary, trail: JSON.parse(r.trail) as TrailStep[],
      })),
    },
    runs: runs.map((run) => summarise(run).head),
  };
}
