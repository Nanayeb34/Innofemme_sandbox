import { getConfig } from "./config/store";
import type { ScenarioId } from "./config/schemas";
import { notificationEnabled, notify, cedis, clock, placeCall, sendSms } from "./notify";
import { getWallet, transfer, walletByMsisdn, type Actor, type TransferRequest, type WalletRow } from "./payments";
import { createRtp } from "./rtp";
import { menuWouldWarn, schedule, populationCache } from "./sim";
import type { World } from "./world";
import { HOUR, MINUTE, TELCO_INFO, ghs, newId } from "./util";

/**
 * Scam bots. Each attack produces lures (SMS, calls, payment prompts) and
 * money movements that carry hidden ground-truth labels (scenario, is_fraud).
 * Featured personas only ever receive lures; the participant decides.
 */

const PERSONA_TARGET_RATE = 0.12;

function pickVictim(w: World, allowPersona = true): WalletRow {
  const c = populationCache(w);
  if (allowPersona && w.rng.chance(PERSONA_TARGET_RATE)) return getWallet(w, w.rng.pick(c.personas.slice(0, 3)))!;
  return getWallet(w, w.rng.pick(c.customers))!;
}
const isPersona = (w: World, wallet: WalletRow) => populationCache(w).personas.includes(wallet.id);
const fraudster = (w: World) => getWallet(w, w.rng.pick(populationCache(w).fraudsters))!;
const mule = (w: World, minimumOnly = false) => getWallet(w, w.rng.pick(minimumOnly ? populationCache(w).minimumMules : populationCache(w).mules))!;
const spoofNumber = (w: World) => w.rng.pick(["024", "054", "055", "020", "050", "027"]) + String(w.rng.int(1000000, 9999999));

/** Records a fraud attempt that was stopped before any money moved (e.g. the owner froze the wallet). */
function recordStopped(w: World, scenario: ScenarioId, from: WalletRow, to: WalletRow | undefined, amount: number, reason: string) {
  w.db
    .prepare(
      `INSERT INTO txns(id, type, channel, initiated_by, from_wallet, to_wallet, from_telco, to_telco, rail, amount, fee, status, reason, created_at, scenario, is_fraud)
       VALUES(?, 'p2p', 'ussd', 'bot', ?, ?, ?, ?, 'onnet', ?, 0, 'blocked', ?, ?, ?, 1)`,
    )
    .run(newId("tx"), from.id, to?.id ?? null, from.telco, to?.telco ?? null, amount, reason, w.now, scenario);
}

/** A victim-initiated transfer: menu warnings and fraud checks can talk the victim out of it. */
async function victimSends(w: World, scenario: ScenarioId, victim: WalletRow, to: WalletRow, amount: number, extra: Partial<TransferRequest> = {}) {
  const req: TransferRequest = {
    type: "p2p",
    channel: "ussd",
    initiatedBy: "bot",
    from: victim.id,
    to: to.id,
    amount: Math.min(amount, Math.max(0, victim.balance - ghs(2))),
    actor: "victim",
    scenario,
    isFraud: true,
    ...extra,
  };
  if (req.amount < ghs(1)) return;
  if (menuWouldWarn(w, victim, req)) {
    req.warned = true;
    if (w.rng.chance(0.55)) {
      recordAbandoned(w, req, victim, to, "Cancelled at menu warning");
      return;
    }
  }
  const r = await transfer(w, req);
  if (r.status === "success" && r.txnId) afterSuccess(w, r.txnId, victim, to, "victim", scenario);
  if (r.status === "held" && r.txnId && w.rng.chance(0.55)) schedule(w, w.rng.int(5, 90) * MINUTE, "report", { txnId: r.txnId, msisdn: victim.msisdn, category: scenario });
}

export function recordAbandoned(w: World, req: TransferRequest, from: WalletRow, to: WalletRow | undefined, reason: string) {
  w.db
    .prepare(
      `INSERT INTO txns(id, type, channel, initiated_by, from_wallet, to_wallet, from_telco, to_telco, rail, amount, fee, status, reason, created_at, warned, scenario, is_fraud)
       VALUES(?,?,?,?,?,?,?,?,?,?,0,'abandoned',?,?,1,?,?)`,
    )
    .run(newId("tx"), req.type, req.channel, req.initiatedBy, from.id, to?.id ?? null, from.telco, to?.telco ?? null, to && to.telco !== from.telco ? "switch" : "onnet", req.amount, reason, w.now, req.scenario ?? null, req.isFraud ? 1 : 0);
}

/** Successful fraud: the victim may report it later, and the proceeds start moving through mules. */
function afterSuccess(w: World, txnId: string, victim: WalletRow, to: WalletRow, actor: Actor, scenario: ScenarioId) {
  const reportChance = actor === "impostor" ? 0.75 : 0.6;
  if (w.rng.chance(reportChance)) schedule(w, w.rng.int(1, 30) * HOUR, "report", { txnId, msisdn: victim.msisdn, category: scenario });
  if (w.rng.chance(0.7)) schedule(w, w.rng.int(10, 90) * MINUTE, "launder", { wallet: to.id, hops: w.rng.int(1, 3), scenario });
}

/** An impostor drains a wallet they control (stolen PIN or swapped SIM). */
export async function drain(w: World, scenario: ScenarioId, victimId: string, opts: { otpShareChance: number; viaAgent?: boolean }) {
  const victim = getWallet(w, victimId)!;
  if (victim.status !== "active") return;
  const tier = getConfig(w.db, "rules").kycTiers[victim.kyc_tier];
  let amount = Math.min(Math.floor(victim.balance * w.rng.int(70, 95) / 100), ghs(tier.daily) - ghs(5));
  amount = Math.floor(amount / 100) * 100;
  if (amount < ghs(20)) return;

  if (opts.viaAgent) {
    const agents = populationCache(w).colludingAgents;
    const sameNetwork = agents.filter((a) => getWallet(w, a)?.telco === victim.telco);
    const agent = getWallet(w, w.rng.pick(sameNetwork.length ? sameNetwork : populationCache(w).agentsByTelco[victim.telco] ?? populationCache(w).agents))!;
    const r = await transfer(w, { type: "cashout", channel: "ussd", initiatedBy: "bot", from: victim.id, to: agent.id, amount, actor: "impostor", newDevice: true, scenario, isFraud: true, otpShareChance: opts.otpShareChance });
    if (r.status === "success" && r.txnId && w.rng.chance(0.75)) schedule(w, w.rng.int(1, 12) * HOUR, "report", { txnId: r.txnId, msisdn: victim.msisdn, category: scenario });
    return;
  }
  const to = mule(w);
  const r = await transfer(w, { type: "p2p", channel: "app", initiatedBy: "bot", from: victim.id, to: to.id, amount, actor: "impostor", newDevice: true, scenario, isFraud: true, otpShareChance: opts.otpShareChance });
  if (r.status === "success" && r.txnId) afterSuccess(w, r.txnId, victim, to, "impostor", scenario);
  if (r.status === "held" && r.txnId && w.rng.chance(0.7)) schedule(w, w.rng.int(10, 120) * MINUTE, "report", { txnId: r.txnId, msisdn: victim.msisdn, category: scenario });
}

/** Moves proceeds onward through mules, across networks, ending in a bank or cash-out. */
export async function launder(w: World, walletId: string, hops: number, scenario: ScenarioId) {
  const from = getWallet(w, walletId)!;
  if (from.balance < ghs(30) || from.status !== "active") return;
  const amount = Math.floor((from.balance * w.rng.int(85, 97)) / 100 / 100) * 100;
  const c = populationCache(w);
  if (hops <= 0) {
    const bank = c.bankAccounts.find((b) => b.wallet === from.id) ?? (w.rng.chance(0.5) ? w.rng.pick(c.bankAccounts.filter((b) => c.mules.includes(b.wallet) || c.fraudsters.includes(b.wallet))) : undefined);
    if (bank) await transfer(w, { type: "to_bank", channel: "app", initiatedBy: "bot", from: from.id, bankAccount: bank.id, amount, scenario, isFraud: true, laundering: true });
    else await transfer(w, { type: "cashout", channel: "ussd", initiatedBy: "bot", from: from.id, to: w.rng.pick(c.agentsByTelco[from.telco] ?? c.agents), amount, scenario, isFraud: true, laundering: true });
    return;
  }
  // Prefer a mule on a different network to make the trail harder to follow.
  let next = mule(w);
  for (let i = 0; i < 4 && next.telco === from.telco; i++) next = mule(w);
  const r = await transfer(w, { type: "p2p", channel: "app", initiatedBy: "bot", from: from.id, to: next.id, amount, scenario, isFraud: true, laundering: true });
  if (r.status === "success") schedule(w, w.rng.int(5, 60) * MINUTE, "launder", { wallet: next.id, hops: hops - 1, scenario });
}

export const ATTACKS: Record<ScenarioId, (w: World) => Promise<void>> = {
  async reversal_scam(w) {
    const victim = pickVictim(w);
    const crook = fraudster(w);
    const amount = ghs(w.rng.pick([150, 200, 300, 450, 500, 650, 800]));
    const fakeFrom = `${w.rng.pick(["KWAKU", "ABENA", "YAW", "AKUA"])} ${w.rng.pick(["ADDO", "OWUSU", "MENSAH"])}`;
    sendSms(
      w,
      victim.msisdn,
      crook.msisdn,
      `Payment received for GHS ${cedis(amount)} from ${fakeFrom} ${crook.msisdn}. Current Balance: GHS ${cedis(victim.balance + amount)}. Available Balance: GHS ${cedis(victim.balance + amount)}. Reference: school fees. Transaction ID: ${w.rng.int(30000000000, 49999999999)}`,
      "reversal_scam",
    );
    placeCall(w, victim.msisdn, crook.msisdn, crook.msisdn, `Please my sister, I have sent GHS ${cedis(amount)} to your number by mistake. It is my child's school fees. Please send it back to ${crook.msisdn}, God bless you.`, "reversal_scam");
    if (isPersona(w, victim)) return;
    let p = 0.12 + victim_s(w, victim) * 0.35;
    if (notificationEnabled(w, "large_inbound")) p *= 0.6;
    if (w.rng.chance(p)) await victimSends(w, "reversal_scam", victim, crook, amount, { reference: "reversal" });
  },

  async pin_phishing(w) {
    const victim = pickVictim(w);
    const crook = fraudster(w);
    const brand = TELCO_INFO[victim.telco].wallet;
    placeCall(w, victim.msisdn, spoofNumber(w), `${brand} Customer Service`, `Hello, this is ${brand} customer service. Your wallet will be blocked today because your Ghana Card is not verified. To keep it active, please confirm your PIN and the code we are sending you now.`, "pin_phishing");
    if (isPersona(w, victim)) return;
    if (!w.rng.chance(0.1 + victim_s(w, victim) * 0.35)) return;
    const s = victim_s(w, victim);
    // With the PIN, the crook logs in from their own phone.
    if (notificationEnabled(w, "new_device")) {
      notify(w, "new_device", victim.msisdn, { time: clock(w.now) });
      if (w.rng.chance(0.4)) {
        w.db.prepare("UPDATE wallets SET status = 'frozen' WHERE id = ?").run(victim.id);
        recordStopped(w, "pin_phishing", victim, crook, ghs(100), "Owner froze wallet after new-device alert");
        schedule(w, 6 * HOUR, "unfreeze", { wallet: victim.id });
        return;
      }
    }
    await drain(w, "pin_phishing", victim.id, { otpShareChance: s * 0.6 });
  },

  async sim_swap(w) {
    const victim = pickVictim(w, false);
    if (victim.balance < ghs(200)) return;
    w.db.prepare("UPDATE sims SET last_swap_at = ? WHERE msisdn = ?").run(w.now, victim.msisdn);
    if (notificationEnabled(w, "sim_swap")) {
      notify(w, "sim_swap", victim.msisdn, { time: clock(w.now) });
      if (w.rng.chance(0.55)) {
        w.db.prepare("UPDATE wallets SET status = 'frozen' WHERE id = ?").run(victim.id);
        recordStopped(w, "sim_swap", victim, undefined, Math.floor(victim.balance * 0.8), "Owner froze wallet after SIM-swap alert");
        schedule(w, 12 * HOUR, "unfreeze", { wallet: victim.id });
        return;
      }
    }
    // SMS codes go to the swapped SIM, so they do not stop this attack; a biometric check does.
    const method = getConfig(w.db, "rules").secondFactor.method;
    schedule(w, w.rng.int(20, 120) * MINUTE, "drain", { wallet: victim.id, scenario: "sim_swap", otpShareChance: method === "sms_otp" ? 1 : 0 });
  },

  async agent_fraud(w) {
    if (w.rng.chance(0.5)) {
      // Fake "head office" call asking an agent to move float.
      const agent = getWallet(w, w.rng.pick(populationCache(w).agents))!;
      const crook = fraudster(w);
      const amount = ghs(w.rng.pick([500, 800, 1000, 1500, 2000]));
      placeCall(w, agent.msisdn, spoofNumber(w), `${TELCO_INFO[agent.telco].name} Agent Support`, `This is agent support. We are reconciling float in your area. Send GHS ${cedis(amount)} to our reconciliation number ${crook.msisdn}; it will be refunded with your commission tonight.`, "agent_fraud");
      if (w.rng.chance(0.3)) await victimSends(w, "agent_fraud", agent, crook, amount, { reference: "float reconciliation" });
    } else {
      // Stolen wallet cashed out at a complicit agent late at night.
      const victim = pickVictim(w, false);
      await drain(w, "agent_fraud", victim.id, { otpShareChance: 0.3, viaAgent: true });
    }
  },

  async mule_chain(w) {
    const src = fraudster(w);
    if (src.balance < ghs(100)) {
      // Seed proceeds from a compromised bank account (e.g. internet banking fraud).
      const c = populationCache(w);
      const bank = w.rng.pick(c.bankAccounts.filter((b) => c.customers.includes(b.wallet)));
      await transfer(w, { type: "from_bank", channel: "system", initiatedBy: "bot", bankAccount: bank.id, to: src.id, amount: ghs(w.rng.pick([800, 1200, 1800, 2500])), scenario: "mule_chain", isFraud: true, laundering: true, skipChecks: true });
    }
    await launder(w, src.id, w.rng.int(2, 4), "mule_chain");
  },

  async fake_promo(w) {
    const victim = pickVictim(w);
    const crook = fraudster(w);
    const prize = w.rng.pick([2000, 5000, 10000]);
    const fee = ghs(w.rng.pick([50, 80, 100, 150]));
    sendSms(w, victim.msisdn, crook.msisdn, `CONGRATULATIONS! Your number has won GHS ${prize} in the ${TELCO_INFO[victim.telco].wallet} Yɛnkɔ Promo. To claim, send processing fee of GHS ${cedis(fee)} to our agent ${crook.msisdn}. Offer ends today.`, "fake_promo");
    if (isPersona(w, victim)) return;
    if (w.rng.chance(0.05 + victim_s(w, victim) * 0.25)) await victimSends(w, "fake_promo", victim, crook, fee, { reference: "promo fee" });
  },

  async rtp_abuse(w) {
    const victim = pickVictim(w);
    const c = populationCache(w);
    const payee = getWallet(w, w.rng.pick(c.fakeMerchants))!;
    const amount = ghs(w.rng.pick([120, 250, 300, 400, 600]));
    sendSms(w, victim.msisdn, spoofNumber(w), `Hello, I am sending you GHS ${cedis(amount)} for the item you posted. You will get a prompt; approve it to receive the money.`, "rtp_abuse");
    const r = createRtp(w, { payeeWallet: payee.id, payerMsisdn: victim.msisdn, amount, payerMessage: "Payment for item", scenario: "rtp_abuse", isFraud: true });
    if ("ref" in r && !isPersona(w, victim)) schedule(w, w.rng.int(1, 4) * MINUTE, "rtp_decide", { ref: r.ref, approve: 0.1 + victim_s(w, victim) * 0.45, actor: "victim" });
  },

  async fake_merchant_qr(w) {
    const victim = pickVictim(w, false);
    const c = populationCache(w);
    const fake = getWallet(w, w.rng.pick(c.fakeMerchants))!;
    const req: TransferRequest = { type: "merchant", channel: "app", initiatedBy: "bot", from: victim.id, to: fake.id, amount: ghs(w.rng.amount(60, 0.6)), actor: "victim", scenario: "fake_merchant_qr", isFraud: true };
    if (req.amount > victim.balance) return;
    const r = await transfer(w, req);
    if (r.status === "success" && r.txnId) afterSuccess(w, r.txnId, victim, fake, "victim", "fake_merchant_qr");
  },

  async relative_impersonation(w) {
    const victim = pickVictim(w);
    const crook = fraudster(w);
    const amount = ghs(w.rng.pick([200, 300, 350, 500, 700]));
    const who = w.rng.pick(["Ma", "Dad", "Auntie", "Bro", "Sis"]);
    sendSms(w, victim.msisdn, crook.msisdn, `${who} it's me, my phone fell in water so I'm using my friend's number. I'm at the hospital and they want GHS ${cedis(amount)} before they treat me. Pls send to this number now, I will explain.`, "relative_impersonation");
    if (isPersona(w, victim)) return;
    if (w.rng.chance(0.08 + victim_s(w, victim) * 0.3)) await victimSends(w, "relative_impersonation", victim, crook, amount, { reference: "hospital" });
  },

  async limit_splitting(w) {
    // A medium-tier mule receives a large sum, then splits it into sub-limit transfers to many low-tier mules.
    const c = populationCache(w);
    const hub = getWallet(w, w.rng.pick(c.mules))!;
    const bank = w.rng.pick(c.bankAccounts.filter((b) => c.customers.includes(b.wallet)));
    const total = ghs(w.rng.pick([6000, 8000, 12000]));
    w.db.prepare("UPDATE wallets SET kyc_tier = 'medium' WHERE id = ?").run(hub.id);
    const seeded = await transfer(w, { type: "from_bank", channel: "system", initiatedBy: "bot", bankAccount: bank.id, to: hub.id, amount: total, scenario: "limit_splitting", isFraud: true, laundering: true, skipChecks: true });
    if (seeded.status !== "success") return;
    const parts = w.rng.int(5, 10);
    for (let i = 0; i < parts; i++) schedule(w, w.rng.int(1, 55) * MINUTE, "split", { from: hub.id, amount: ghs(w.rng.int(900, 2900)) });
  },
};

const victim_s = (w: World, wallet: WalletRow) =>
  wallet.person_id ? (w.db.prepare("SELECT susceptibility FROM persons WHERE id = ?").get(wallet.person_id) as { susceptibility: number }).susceptibility : 0.3;

export async function split(w: World, fromId: string, amount: number) {
  const from = getWallet(w, fromId)!;
  if (from.balance < amount) return;
  const to = mule(w, true);
  const r = await transfer(w, { type: "p2p", channel: "app", initiatedBy: "bot", from: from.id, to: to.id, amount, scenario: "limit_splitting", isFraud: true, laundering: true });
  if (r.status === "success") schedule(w, w.rng.int(10, 120) * MINUTE, "launder", { wallet: to.id, hops: 0, scenario: "limit_splitting" });
}

export { walletByMsisdn };
