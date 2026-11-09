import { getConfig } from "./config/store";
import type { Menu, ScenarioId } from "./config/schemas";
import { computeFacts, evaluate } from "./facts";
import { ATTACKS, drain, launder, recordAbandoned, split } from "./fraud";
import { getMeta, tx } from "./db";
import { getWallet, releaseHolds, reportFraud, transfer, type TransferRequest, type WalletRow } from "./payments";
import { approveRtp, expireRtps, rejectRtp } from "./rtp";
import { advanceClock, type PopulationCache, type World } from "./world";
import { DAY, MINUTE, ghs } from "./util";

const STEP = 5 * MINUTE;

// Relative activity by hour of day (Ghana time), averaging ~1.
const HOURLY = [0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.8, 1.3, 1.5, 1.5, 1.5, 1.5, 1.6, 1.5, 1.4, 1.4, 1.5, 1.6, 1.6, 1.4, 1.2, 0.9, 0.5, 0.25];
const HOURLY_MEAN = HOURLY.reduce((a, b) => a + b, 0) / 24;

export function populationCache(w: World): PopulationCache {
  if (w.cache) return w.cache;
  const ids = (sql: string) => (w.db.prepare(sql).all() as { id: string }[]).map((r) => r.id);
  const personas = Object.values(JSON.parse(getMeta(w.db, "personas") ?? "{}") as Record<string, string>).map((m) => `w_${m}`);
  const customers = ids("SELECT w.id FROM wallets w JOIN persons p ON p.id = w.person_id WHERE p.role = 'customer' AND w.owner_type = 'person' AND p.persona IS NULL");
  const agentsByTelco: Record<string, string[]> = {};
  for (const r of w.db.prepare("SELECT a.wallet_id AS id, w.telco FROM agents a JOIN wallets w ON w.id = a.wallet_id WHERE a.colluding = 0").all() as { id: string; telco: string }[]) {
    (agentsByTelco[r.telco] ??= []).push(r.id);
  }
  w.cache = {
    customers,
    agentsByTelco,
    personas,
    agents: ids("SELECT wallet_id AS id FROM agents WHERE colluding = 0"),
    colludingAgents: ids("SELECT wallet_id AS id FROM agents WHERE colluding = 1"),
    merchants: ids("SELECT wallet_id AS id FROM merchants WHERE fake = 0"),
    fakeMerchants: ids("SELECT wallet_id AS id FROM merchants WHERE fake = 1"),
    fraudsters: ids("SELECT w.id FROM wallets w JOIN persons p ON p.id = w.person_id WHERE p.role = 'fraudster' AND w.owner_type = 'person'"),
    mules: ids("SELECT w.id FROM wallets w JOIN persons p ON p.id = w.person_id WHERE p.role = 'mule'"),
    minimumMules: ids("SELECT w.id FROM wallets w JOIN persons p ON p.id = w.person_id WHERE p.role = 'mule' AND w.kyc_tier = 'minimum'"),
    bankAccounts: (w.db.prepare("SELECT b.id, (SELECT id FROM wallets WHERE person_id = b.person_id LIMIT 1) AS wallet FROM bank_accounts b").all() as { id: string; wallet: string }[]),
    payroll: [],
  };
  return w.cache;
}

export function schedule(w: World, delayMs: number, kind: string, payload: unknown) {
  w.db.prepare("INSERT INTO agenda(at, kind, payload) VALUES(?,?,?)").run(w.now + delayMs, kind, JSON.stringify(payload));
}

/**
 * Would a bot user see a warning screen on the way to this payment?
 * Walks the sender's menu tree, evaluating branch conditions with the payment's facts.
 */
export function menuWouldWarn(w: World, from: WalletRow, req: TransferRequest): boolean {
  const menu: Menu = getConfig(w.db, "menus")[from.telco];
  const nodes = Object.values(menu.nodes);
  if (!nodes.some((n) => n.type === "warning")) return false;
  const action = req.type === "merchant" ? "pay_merchant" : req.type === "to_bank" ? "to_bank" : req.type === "p2p" ? "send_money" : undefined;
  if (!action) return false;
  const to = req.to ? getWallet(w, req.to) : undefined;
  const facts = computeFacts(w, {
    type: req.type,
    channel: "ussd",
    fromWallet: from.id,
    toWallet: req.to,
    recipientType: to?.owner_type ?? "person",
    amount: req.amount,
    crossNetwork: !!to && to.telco !== from.telco,
  });
  const seen = new Set<string>();
  const walk = (id: string, warned: boolean): boolean => {
    const key = `${id}:${warned}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const n = menu.nodes[id];
    if (!n) return false;
    switch (n.type) {
      case "menu":
        return n.options.some((o) => walk(o.next, warned));
      case "input":
      case "set":
        return walk(n.next, warned);
      case "warning":
        return walk(n.next, true);
      case "branch":
        return walk(evaluate(n.if, facts) ? n.then : n.else, warned);
      case "action":
        return n.action === action && warned;
      default:
        return false;
    }
  };
  return walk(menu.start, false);
}

function rate(w: World, perDay: number, dt: number): number {
  const d = new Date(w.now);
  const hourly = HOURLY[d.getUTCHours()] / HOURLY_MEAN;
  const dow = d.getUTCDay();
  const weekly = dow === 0 ? 0.7 : dow === 6 ? 1.1 : 1;
  const dom = d.getUTCDate();
  const payday = dom >= 25 || dom <= 2 ? 1.3 : 1;
  return perDay * (dt / DAY) * hourly * weekly * payday;
}

async function legitTxn(w: World) {
  const c = populationCache(w);
  const from = getWallet(w, w.rng.pick(c.customers))!;
  if (from.status !== "active") return;
  const r = w.rng.next();
  const channel = w.rng.chance(0.6) ? "ussd" : "app";
  const base = { channel, initiatedBy: "bot", from: from.id, actor: "owner", newDevice: w.rng.chance(0.02) } as const;
  let req: TransferRequest;
  const day = new Date(w.now).getUTCDate();

  if (r < 0.55) {
    const contacts = w.db.prepare("SELECT contact FROM contacts WHERE msisdn = ?").all(from.msisdn) as { contact: string }[];
    const toId = contacts.length && w.rng.chance(0.85) ? `w_${w.rng.pick(contacts).contact}` : w.rng.pick(c.customers);
    req = { ...base, type: "p2p", to: toId, amount: ghs(w.rng.amount(80, 0.9)) };
  } else if (r < 0.77) {
    req = { ...base, type: "merchant", to: w.rng.pick(c.merchants), amount: ghs(w.rng.amount(35, 0.8)) };
  } else if (r < 0.86) {
    req = { ...base, type: "cashout", to: w.rng.pick(c.agentsByTelco[from.telco] ?? c.agents), amount: ghs(w.rng.amount(200, 0.7)) };
  } else if (r < 0.95) {
    const agent = w.rng.pick(c.agentsByTelco[from.telco] ?? c.agents);
    await transfer(w, { type: "cashin", channel: "ussd", initiatedBy: "bot", from: agent, to: from.id, amount: ghs(w.rng.amount(250, 0.7)) });
    return;
  } else if (r < 0.97 || !(day >= 25 || day <= 2)) {
    const bank = c.bankAccounts.find((b) => b.wallet === from.id);
    if (!bank) return;
    req = { ...base, type: "to_bank", bankAccount: bank.id, amount: ghs(w.rng.amount(500, 0.7)) };
  } else {
    // Salary or allowance landing in the wallet around payday.
    const bank = c.bankAccounts.find((b) => b.wallet === from.id) ?? w.rng.pick(c.bankAccounts);
    await transfer(w, { type: "from_bank", channel: "system", initiatedBy: "bot", bankAccount: bank.id, to: from.id, amount: ghs(w.rng.amount(1500, 0.6)), skipChecks: true });
    return;
  }
  if (req.amount > from.balance) req.amount = Math.floor(from.balance * 0.6 / 100) * 100;
  if (req.amount < ghs(1)) return;
  if (menuWouldWarn(w, from, req)) {
    req.warned = true;
    if (w.rng.chance(0.04)) {
      recordAbandoned(w, req, from, req.to ? getWallet(w, req.to) : undefined, "Cancelled at menu warning");
      return;
    }
  }
  await transfer(w, req);
}

async function runAgenda(w: World) {
  const due = w.db.prepare("SELECT * FROM agenda WHERE at <= ? ORDER BY at").all(w.now) as { id: number; kind: string; payload: string }[];
  for (const item of due) {
    w.db.prepare("DELETE FROM agenda WHERE id = ?").run(item.id);
    const p = JSON.parse(item.payload);
    switch (item.kind) {
      case "report":
        reportFraud(w, p.txnId, p.msisdn, p.category);
        break;
      case "launder":
        await launder(w, p.wallet, p.hops, p.scenario);
        break;
      case "drain":
        await drain(w, p.scenario, p.wallet, { otpShareChance: p.otpShareChance });
        break;
      case "split":
        await split(w, p.from, p.amount);
        break;
      case "unfreeze":
        w.db.prepare("UPDATE wallets SET status = 'active' WHERE id = ? AND status = 'frozen'").run(p.wallet);
        break;
      case "rtp_decide":
        if (w.rng.chance(p.approve)) await approveRtp(w, p.ref, { initiatedBy: "bot", actor: p.actor });
        else rejectRtp(w, p.ref, "Rejected by payer");
        break;
    }
  }
}

/** Population members answer payment requests that team apps send them. */
async function answerTeamRtps(w: World) {
  const c = populationCache(w);
  const pending = w.db.prepare("SELECT ref, payer_msisdn, amount FROM rtp WHERE status = 'PENDING' AND scenario IS NULL AND created_at <= ?").all(w.now - MINUTE) as {
    ref: string;
    payer_msisdn: string;
    amount: number;
  }[];
  for (const r of pending) {
    if (c.personas.includes(`w_${r.payer_msisdn}`)) continue;
    const payer = getWallet(w, `w_${r.payer_msisdn}`);
    if (payer && payer.balance >= r.amount && w.rng.chance(0.85)) await approveRtp(w, r.ref, { initiatedBy: "bot" });
    else rejectRtp(w, r.ref, payer ? "Payer declined" : "PAYER_NOT_FOUND");
  }
}

async function step(w: World, dt: number) {
  const scen = getConfig(w.db, "scenarios");
  const legit = w.rng.poisson(rate(w, scen.legitTxnsPerDay, dt));
  for (let i = 0; i < legit; i++) await legitTxn(w);
  for (const s of scen.scenarios) {
    if (!s.enabled) continue;
    const n = w.rng.poisson(rate(w, s.perDay, dt));
    for (let i = 0; i < n; i++) await ATTACKS[s.id as ScenarioId](w);
  }
  for (const s of hiddenScenarios(w)) {
    const n = w.rng.poisson(rate(w, s.perDay, dt));
    for (let i = 0; i < n; i++) await ATTACKS[s.id](w);
  }
  await runAgenda(w);
  await answerTeamRtps(w);
  releaseHolds(w);
  expireRtps(w);
}

/** Organiser-only scenarios (e.g. the demo-day surprise) that teams cannot see or switch off. */
export function hiddenScenarios(w: World): { id: ScenarioId; perDay: number }[] {
  return JSON.parse(getMeta(w.db, "hidden_scenarios") ?? "[]");
}

/** Advances the world's clock to `target`, simulating everything in between. */
export async function runUntil(w: World, target: number) {
  while (w.now < target) {
    const dt = Math.min(STEP, target - w.now);
    w.db.exec("BEGIN");
    try {
      advanceClock(w, w.now + dt);
      await step(w, dt);
      w.db.exec("COMMIT");
    } catch (e) {
      w.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export async function fastForward(w: World, hours: number) {
  await runUntil(w, w.now + hours * 60 * MINUTE);
}

export { tx };
