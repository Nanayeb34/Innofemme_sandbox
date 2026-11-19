import { randomInt } from "node:crypto";
import { getConfig } from "./config/store";
import type { KycTier } from "./config/schemas";
import { count, tx } from "./db";
import { getWallet, walletByMsisdn, type WalletRow } from "./ledger";
import { ageOf, fullName, personById, verify, type Person } from "./nia";
import { createApproval } from "./approvals";
import { consult, emit } from "./integrations";
import { notify, sendSms } from "./notify";
import { walletPay, type Receipt } from "./payments";
import { SimError, TELCO_INFO, amountOf, cedis, digits, need, normalizeMsisdn, telcoOf, type Telco } from "./util";
import { audit, type World } from "./world";

/**
 * What a telco does outside moving money: SIM stock, SIM registration against the Ghana Card,
 * replacements and blocks, opening and managing wallets, and onboarding agents and merchants.
 */

export interface SimRow {
  msisdn: string;
  telco: Telco;
  iccid: string;
  puk: string;
  status: "in_stock" | "active" | "blocked" | "deactivated";
  person_id: string | null;
  registered_at: number | null;
  registered_by: string | null;
  last_swap_at: number | null;
  block_reason: string | null;
  created_at: number;
}

export interface SimAgentRow {
  id: string;
  telco: Telco;
  person_id: string;
  name: string;
  kind: "service_centre" | "registration_agent";
  town: string;
  status: string;
  created_at: number;
}

export const getSim = (w: World, msisdn: string) => w.db.prepare("SELECT * FROM sims WHERE msisdn = ?").get(msisdn) as SimRow | undefined;
const simEvent = (w: World, msisdn: string, kind: string, by: string, detail = "") => w.db.prepare("INSERT INTO sim_events(msisdn, at, kind, by, detail) VALUES(?,?,?,?,?)").run(msisdn, w.now, kind, by, detail);
const newIccid = () => `8923301${digits(12)}`;
const pinOk = (pin: unknown): string => {
  if (!/^\d{4}$/.test(String(pin ?? ""))) throw new SimError("PIN must be 4 digits");
  return String(pin);
};

/** How a customer is described to an API the network has plugged in. */
const customerOf = (p: Person | undefined) => (p ? { name: fullName(p), ghanaCard: p.ghana_card, dateOfBirth: p.dob, gender: p.gender, region: p.region } : null);
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export type PinReason = "new_wallet" | "change" | "agent_line" | "merchant_line";

/** What is wrong with a PIN someone wants to use, if anything: its format, or the verdict of an API plugged in at "pin.set". */
export function pinProblem(w: World, msisdn: string, pin: unknown, reason: PinReason): string | undefined {
  if (!/^\d{4}$/.test(String(pin ?? ""))) return "PIN must be 4 digits";
  const sim = getSim(w, msisdn);
  if (!sim) return;
  const d = consult(w, sim.telco, "pin.set", { msisdn, pin: String(pin), reason, network: sim.telco, customer: customerOf(personById(w, sim.person_id ?? "")) });
  if (d.decision === "reject") return d.message ?? "That PIN is not allowed. Choose a different one.";
}

/** The PIN, once it has passed the checks. */
function acceptPin(w: World, msisdn: string, pin: unknown, reason: PinReason): string {
  const problem = pinProblem(w, msisdn, pin, reason);
  if (problem) throw new SimError(problem);
  return String(pin);
}

function ownSim(w: World, telco: Telco, msisdnInput: unknown): SimRow {
  const msisdn = normalizeMsisdn(String(need(msisdnInput as string, "Mobile number")));
  const sim = getSim(w, msisdn);
  if (!sim || sim.telco !== telco) throw new SimError(`${msisdn} is not a ${TELCO_INFO[telco].name} number`);
  return sim;
}

function ownWallet(w: World, telco: Telco, msisdnInput: unknown): WalletRow {
  const msisdn = normalizeMsisdn(String(need(msisdnInput as string, "Mobile number")));
  const wallet = walletByMsisdn(w, msisdn);
  if (!wallet || wallet.telco !== telco) throw new SimError(`${msisdn} has no ${TELCO_INFO[telco].wallet} wallet`);
  return wallet;
}

// ---------- SIM stock ----------

/** Adds blank SIM cards with new numbers to the telco's stock. */
export function generateSims(w: World, telco: Telco, n: number): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new SimError("Choose between 1 and 200 SIMs");
  const out: string[] = [];
  const ins = w.db.prepare("INSERT INTO sims(msisdn, telco, iccid, puk, status, created_at) VALUES(?,?,?,?, 'in_stock', ?)");
  tx(w.db, () => {
    while (out.length < n) {
      const prefixes = TELCO_INFO[telco].prefixes;
      const msisdn = prefixes[randomInt(prefixes.length)] + digits(7);
      if (getSim(w, msisdn)) continue;
      ins.run(msisdn, telco, newIccid(), digits(8), w.now);
      out.push(msisdn);
    }
    audit(w, telco, "sim_stock", `Added ${n} blank SIM(s) to stock`);
  });
  return out;
}

// ---------- SIM registration and troubleshooting points ----------

export function onboardSimAgent(w: World, telco: Telco, input: { card?: string; name?: string; kind?: string; town?: string }): SimAgentRow {
  const name = need(input.name?.trim(), "Outlet name");
  const town = need(input.town?.trim(), "Town");
  const kind = input.kind === "service_centre" ? "service_centre" : "registration_agent";
  const p = verify(w, { requester: telco, purpose: "SIM registration agent onboarding", card: input.card, biometric: false });
  if (ageOf(p, w.now) < 18) throw new SimError("An agent must be at least 18 years old");
  const n = count(w.db, "SELECT COUNT(*) AS n FROM sim_agents WHERE telco = ?", telco) + 1;
  const id = `${TELCO_INFO[telco].name.toUpperCase()}-${kind === "service_centre" ? "SC" : "RA"}-${String(n).padStart(4, "0")}`;
  w.db.prepare("INSERT INTO sim_agents(id, telco, person_id, name, kind, town, created_at) VALUES(?,?,?,?,?,?,?)").run(id, telco, p.id, name, kind, town, w.now);
  audit(w, telco, "sim_agent", `Authorised ${kind === "service_centre" ? "service centre" : "SIM registration agent"} ${name} (${id}), run by ${fullName(p)}`);
  return w.db.prepare("SELECT * FROM sim_agents WHERE id = ?").get(id) as unknown as SimAgentRow;
}

export function simAgent(w: World, telco: Telco, id: unknown): SimAgentRow {
  const a = w.db.prepare("SELECT * FROM sim_agents WHERE id = ?").get(String(need(id as string, "Agent"))) as SimAgentRow | undefined;
  if (!a || a.telco !== telco) throw new SimError("Unknown SIM registration point for this network");
  if (a.status !== "active") throw new SimError(`${a.name} is suspended and cannot serve customers`);
  return a;
}

export function setSimAgentStatus(w: World, telco: Telco, id: string, status: "active" | "suspended") {
  const r = w.db.prepare("UPDATE sim_agents SET status = ? WHERE id = ? AND telco = ?").run(status, id, telco);
  if (!r.changes) throw new SimError("SIM registration point not found");
  audit(w, telco, "sim_agent", `${id} set to ${status}`);
}

/**
 * Registers a new SIM: the customer presents a Ghana Card and a fingerprint, the telco checks both with
 * NIA, the regulator's SIM limit is applied, and the chosen number is activated in the customer's name.
 */
export function registerSim(w: World, telco: Telco, agentId: unknown, input: { card?: string; fingerprint?: string; msisdn?: string; otp?: string }): { sim: SimRow; person: Person } {
  const agent = simAgent(w, telco, agentId);
  const p = verify(w, { requester: telco, purpose: `SIM registration at ${agent.id}`, card: input.card, fingerprint: input.fingerprint, biometric: true });
  const nca = getConfig(w.db, "nca");
  if (ageOf(p, w.now) < nca.minimumAge) throw new SimError(`NCA rule: a subscriber must be at least ${nca.minimumAge} years old`);
  const held = count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE person_id = ? AND status IN ('active','blocked')", p.id);
  if (held >= nca.maxSimsPerCard) throw new SimError(`NCA rule: this Ghana Card already has ${held} SIMs, the maximum across all networks`);

  // A further SIM on the same card must be approved from the holder's primary (first) number.
  const primary = w.db.prepare("SELECT msisdn FROM sims WHERE person_id = ? AND status = 'active' ORDER BY registered_at LIMIT 1").get(p.id) as { msisdn: string } | undefined;
  if (primary && nca.primaryNumberApproval) {
    const key = `simreg:${p.id}`;
    const otp = String(input.otp ?? "").trim();
    if (!otp) {
      const sent = digits(6);
      w.otps.set(key, sent);
      sendSms(w, primary.msisdn, "SIMREG", `Your code to approve a new SIM on your Ghana Card is ${sent}. If you did not ask for a new SIM, do not share it.`);
      throw new SimError(`This Ghana Card already has a number. An approval code was sent by SMS to the primary number ${primary.msisdn}. Enter it in "Approval code" and submit again.`);
    }
    if (w.otps.get(key) !== otp) throw new SimError("Wrong approval code");
    w.otps.delete(key);
  }

  const sim = input.msisdn
    ? getSim(w, normalizeMsisdn(input.msisdn))
    : (w.db.prepare("SELECT * FROM sims WHERE telco = ? AND status = 'in_stock' ORDER BY created_at, msisdn LIMIT 1").get(telco) as SimRow | undefined);
  if (!sim) throw new SimError(input.msisdn ? "That number is not in stock" : `No blank SIMs in stock. ${TELCO_INFO[telco].name} must add SIM stock first.`);
  if (sim.telco !== telco || sim.status !== "in_stock") throw new SimError("That number is not available for registration");

  const about = { msisdn: sim.msisdn, network: telco, registeredBy: { id: agent.id, name: agent.name, kind: agent.kind, town: agent.town }, customer: customerOf(p), simsAlreadyOnThisGhanaCard: held, primaryNumber: primary?.msisdn ?? null };
  const verdict = consult(w, telco, "sim.register", about);
  if (verdict.decision === "reject") throw new SimError(verdict.message ?? "This SIM cannot be registered right now.");
  emit(w, telco, "sim.registered", about);

  tx(w.db, () => {
    w.db.prepare("UPDATE sims SET status = 'active', person_id = ?, registered_at = ?, registered_by = ? WHERE msisdn = ?").run(p.id, w.now, agent.id, sim.msisdn);
    simEvent(w, sim.msisdn, "registered", agent.id, `Ghana Card ${p.ghana_card}, biometric match`);
    notify(w, telco, "sim_registered", sim.msisdn, { msisdn: sim.msisdn, name: fullName(p), ghana_card: p.ghana_card });
    audit(w, telco, "sim_registered", `${agent.name} registered ${sim.msisdn} to ${fullName(p)} (${p.ghana_card})`);
  });
  return { sim: getSim(w, sim.msisdn)!, person: p };
}

/** Verifies that the person at the counter is the registered owner of the number. */
function verifyOwner(w: World, telco: Telco, sim: SimRow, by: string, purpose: string, input: { card?: string; fingerprint?: string }): Person {
  if (!sim.person_id) throw new SimError("This number is not registered to anyone");
  const p = verify(w, { requester: telco, purpose: `${purpose} at ${by}`, card: input.card, fingerprint: input.fingerprint, biometric: true });
  if (p.id !== sim.person_id) throw new SimError("This Ghana Card does not belong to the registered owner of the number");
  return p;
}

/** SIM replacement: the number moves to a new SIM card after the owner is verified. */
export function swapSim(w: World, telco: Telco, agentId: unknown, input: { msisdn?: string; card?: string; fingerprint?: string }): SimRow {
  const agent = simAgent(w, telco, agentId);
  const sim = ownSim(w, telco, input.msisdn);
  if (sim.status === "in_stock" || sim.status === "deactivated") throw new SimError("Only a registered number can be replaced");
  const p = verifyOwner(w, telco, sim, agent.id, "SIM replacement", input);
  const hold = getConfig(w.db, `telco.${telco}`).simSwapMomoHoldHours;
  const wallet = walletByMsisdn(w, sim.msisdn);
  const about = {
    msisdn: sim.msisdn,
    network: telco,
    replacedBy: { id: agent.id, name: agent.name, kind: agent.kind, town: agent.town },
    customer: customerOf(p),
    simRegisteredAt: iso(sim.registered_at),
    previousSwapAt: iso(sim.last_swap_at),
    simStatus: sim.status,
    hasWallet: !!wallet,
    walletBalance: wallet ? wallet.balance / 100 : null,
    swapsOnThisNumberBefore: count(w.db, "SELECT COUNT(*) AS n FROM sim_events WHERE msisdn = ? AND kind = 'swapped'", sim.msisdn),
  };
  const verdict = consult(w, telco, "sim.swap", about);
  if (verdict.decision === "reject") throw new SimError(verdict.message ?? "This SIM cannot be replaced right now.");
  emit(w, telco, "sim.swapped", about);
  tx(w.db, () => {
    w.db.prepare("UPDATE sims SET iccid = ?, puk = ?, status = 'active', block_reason = NULL, last_swap_at = ? WHERE msisdn = ?").run(newIccid(), digits(8), w.now, sim.msisdn);
    simEvent(w, sim.msisdn, "swapped", agent.id, `New SIM card issued to ${fullName(p)}${hold ? `; mobile money sending paused for ${hold}h` : ""}`);
    notify(w, telco, "sim_swapped", sim.msisdn, { msisdn: sim.msisdn });
    audit(w, telco, "sim_swap", `${agent.name} replaced the SIM for ${sim.msisdn}`);
  });
  return getSim(w, sim.msisdn)!;
}

/** Blocks (lost or stolen), unblocks or permanently disconnects a number. */
export function setSimStatus(w: World, telco: Telco, by: string, msisdn: unknown, status: "active" | "blocked" | "deactivated", reason = "") {
  const sim = ownSim(w, telco, msisdn);
  if (sim.status === "in_stock") throw new SimError("This number has not been registered yet");
  if (sim.status === "deactivated") throw new SimError("This number has been disconnected permanently");
  if (sim.status === status) throw new SimError(`This number is already ${status}`);
  if (status === "deactivated" && (walletByMsisdn(w, sim.msisdn)?.balance ?? 0) > 0) throw new SimError("The wallet on this number still holds money. Cash it out before disconnecting the number.");
  tx(w.db, () => {
    w.db.prepare("UPDATE sims SET status = ?, block_reason = ? WHERE msisdn = ?").run(status, status === "blocked" ? reason || "Blocked" : null, sim.msisdn);
    simEvent(w, sim.msisdn, status === "active" ? "unblocked" : status, by, reason);
    audit(w, telco, "sim_status", `${sim.msisdn} ${status === "active" ? "unblocked" : status} by ${by}${reason ? `: ${reason}` : ""}`);
  });
}

// ---------- wallets ----------

function openWallet(w: World, sim: SimRow, o: { pin: string; tier: KycTier; ownerType: WalletRow["owner_type"]; displayName: string; by: string }): WalletRow {
  if (sim.status !== "active" || !sim.person_id) throw new SimError("Only an active, registered SIM can hold a wallet");
  if (walletByMsisdn(w, sim.msisdn)) throw new SimError(`${sim.msisdn} already has a ${TELCO_INFO[sim.telco].wallet} wallet`);
  const about = {
    msisdn: sim.msisdn,
    network: sim.telco,
    walletType: o.ownerType,
    walletName: o.displayName,
    kycTier: o.tier,
    openedBy: o.by,
    customer: customerOf(personById(w, sim.person_id)),
    simRegisteredAt: iso(sim.registered_at),
    lastSimSwapAt: iso(sim.last_swap_at),
    walletsOnThisGhanaCard: count(w.db, "SELECT COUNT(*) AS n FROM wallets WHERE person_id = ?", sim.person_id),
  };
  const verdict = consult(w, sim.telco, "wallet.open", about);
  if (verdict.decision === "reject") throw new SimError(verdict.message ?? "This wallet cannot be opened right now.");
  emit(w, sim.telco, "wallet.opened", about);
  const id = `w_${sim.msisdn}`;
  w.db
    .prepare("INSERT INTO wallets(id, msisdn, telco, person_id, owner_type, display_name, kyc_tier, pin, created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, sim.msisdn, sim.telco, sim.person_id, o.ownerType, o.displayName, o.tier, o.pin, w.now);
  notify(w, sim.telco, "wallet_opened", sim.msisdn, {});
  audit(w, sim.telco, "wallet_opened", `${TELCO_INFO[sim.telco].wallet} wallet opened for ${o.displayName} (${sim.msisdn}), ${o.tier} KYC, via ${o.by}`);
  return getWallet(w, id)!;
}

/** A subscriber opens their own wallet from the phone. It starts on the lowest KYC tier. */
export function selfRegisterWallet(w: World, msisdn: string, pin: string): WalletRow {
  const sim = getSim(w, msisdn);
  if (!sim) throw new SimError("Unknown number");
  if (!getConfig(w.db, `telco.${sim.telco}`).selfRegistration) throw new SimError("Visit an agent with your Ghana Card to register for mobile money.");
  const p = personById(w, sim.person_id ?? "");
  if (!p) throw new SimError("This SIM is not registered");
  return tx(w.db, () => openWallet(w, sim, { pin: acceptPin(w, sim.msisdn, pin, "new_wallet"), tier: "minimum", ownerType: "person", displayName: fullName(p), by: "self-registration (USSD)" }));
}

export interface MomoAgentRow {
  wallet_id: string;
  code: string;
  name: string;
  town: string;
  cash: number;
  commission: number;
  status: string;
  created_at: number;
}

export function momoAgent(w: World, telco: Telco, codeInput: unknown): MomoAgentRow & { wallet: WalletRow } {
  const a = w.db.prepare("SELECT * FROM momo_agents WHERE code = ?").get(String(need(codeInput as string, "Agent"))) as MomoAgentRow | undefined;
  const wallet = a ? getWallet(w, a.wallet_id) : undefined;
  if (!a || !wallet || wallet.telco !== telco) throw new SimError("Unknown mobile money agent for this network");
  if (a.status !== "active") throw new SimError(`${a.name} is suspended`);
  return { ...a, wallet };
}

/**
 * A mobile money agent registers a customer in person: Ghana Card and fingerprint are checked with NIA,
 * so the wallet opens on (or is upgraded to) medium KYC.
 */
export function agentRegisterWallet(w: World, telco: Telco, agentCode: unknown, input: { msisdn?: string; card?: string; fingerprint?: string; pin?: string }): WalletRow {
  const agent = momoAgent(w, telco, agentCode);
  const sim = ownSim(w, telco, input.msisdn);
  const p = verifyOwner(w, telco, sim, `agent ${agent.code}`, "Mobile money registration", input);
  const existing = walletByMsisdn(w, sim.msisdn);
  if (existing) {
    if (existing.owner_type !== "person" || existing.kyc_tier !== "minimum") throw new SimError(`${sim.msisdn} already has a wallet on ${existing.kyc_tier} KYC`);
    return upgradeTier(w, telco, sim.msisdn, "medium", `agent ${agent.code}`);
  }
  return tx(w.db, () => openWallet(w, sim, { pin: acceptPin(w, sim.msisdn, input.pin, "new_wallet"), tier: "medium", ownerType: "person", displayName: fullName(p), by: `agent ${agent.name} (${agent.code})` }));
}

export function upgradeTier(w: World, telco: Telco, msisdn: unknown, tier: KycTier, by: string, proofOfAddress?: string): WalletRow {
  const wallet = ownWallet(w, telco, msisdn);
  if (tier === "enhanced" && wallet.owner_type === "person" && !proofOfAddress?.trim()) throw new SimError("Enhanced KYC needs proof of address (utility bill, bank statement or tenancy agreement)");
  const order: KycTier[] = ["minimum", "medium", "enhanced"];
  if (!order.includes(tier)) throw new SimError("Unknown KYC tier");
  if (wallet.kyc_tier === tier) throw new SimError(`Wallet is already on ${tier} KYC`);
  tx(w.db, () => {
    w.db.prepare("UPDATE wallets SET kyc_tier = ? WHERE id = ?").run(tier, wallet.id);
    notify(w, telco, "kyc_upgraded", wallet.msisdn, { tier, daily: getConfig(w.db, "bog").kycTiers[tier].daily });
    audit(w, telco, "kyc", `${wallet.display_name} (${wallet.msisdn}) moved from ${wallet.kyc_tier} to ${tier} KYC by ${by}`);
  });
  return getWallet(w, wallet.id)!;
}

export function setWalletStatus(w: World, telco: Telco, msisdn: unknown, status: "active" | "frozen", reason = "") {
  const wallet = ownWallet(w, telco, msisdn);
  if (wallet.status === status) throw new SimError(`Wallet is already ${status}`);
  w.db.prepare("UPDATE wallets SET status = ?, pin_fails = 0 WHERE id = ?").run(status, wallet.id);
  audit(w, telco, "wallet_status", `Wallet ${wallet.msisdn} set to ${status}${reason ? `: ${reason}` : ""}`);
}

/** PIN reset after the owner is verified in person. A temporary PIN is sent by SMS and the wallet is unlocked. */
export function resetPin(w: World, telco: Telco, by: string, input: { msisdn?: string; card?: string; fingerprint?: string }) {
  const sim = ownSim(w, telco, input.msisdn);
  const wallet = ownWallet(w, telco, input.msisdn);
  verifyOwner(w, telco, sim, by, "Mobile money PIN reset", input);
  const pin = digits(4);
  tx(w.db, () => {
    w.db.prepare("UPDATE wallets SET pin = ?, pin_fails = 0, status = CASE WHEN status = 'locked' THEN 'active' ELSE status END WHERE id = ?").run(pin, wallet.id);
    simEvent(w, sim.msisdn, "pin_reset", by, "Owner verified with Ghana Card and fingerprint");
    notify(w, telco, "pin_reset", wallet.msisdn, { pin });
    audit(w, telco, "pin_reset", `Wallet PIN reset for ${wallet.msisdn} by ${by}`);
  });
}

export function changePin(w: World, wallet: WalletRow, newPin: string) {
  w.db.prepare("UPDATE wallets SET pin = ? WHERE id = ?").run(acceptPin(w, wallet.msisdn, newPin, "change"), wallet.id);
  emit(w, wallet.telco, "pin.changed", { msisdn: wallet.msisdn, network: wallet.telco });
}

// ---------- mobile money agents and merchants ----------

/** A business line: an active, registered SIM on this network that has no wallet yet. */
function businessLine(w: World, telco: Telco, msisdn: unknown): { sim: SimRow; person: Person } {
  const sim = ownSim(w, telco, msisdn);
  if (sim.status !== "active" || !sim.person_id) throw new SimError("The SIM must be registered and active first");
  if (walletByMsisdn(w, sim.msisdn)) throw new SimError("This number already has a wallet. A business needs its own dedicated SIM line.");
  const person = personById(w, sim.person_id)!;
  if (ageOf(person, w.now) < 18) throw new SimError("The owner must be at least 18 years old");
  return { sim, person };
}

function nextCode(w: World, table: "momo_agents" | "merchants", column: "code" | "till", base: number) {
  return String(base + count(w.db, `SELECT COUNT(*) AS n FROM ${table}`) + 1);
}

export function onboardMomoAgent(w: World, telco: Telco, input: { msisdn?: string; name?: string; town?: string; pin?: string }): MomoAgentRow {
  const name = need(input.name?.trim(), "Business name");
  const town = need(input.town?.trim(), "Town");
  pinOk(input.pin);
  const { sim, person } = businessLine(w, telco, input.msisdn);
  const pin = acceptPin(w, sim.msisdn, input.pin, "agent_line");
  verify(w, { requester: telco, purpose: "Mobile money agent onboarding", card: person.ghana_card, biometric: false });
  const agentCode = nextCode(w, "momo_agents", "code", 200000);
  tx(w.db, () => {
    const wallet = openWallet(w, sim, { pin, tier: "enhanced", ownerType: "agent", displayName: name, by: "agent onboarding" });
    w.db.prepare("INSERT INTO momo_agents(wallet_id, code, name, town, created_at) VALUES(?,?,?,?,?)").run(wallet.id, agentCode, name, town, w.now);
    audit(w, telco, "momo_agent", `Onboarded mobile money agent ${name} (agent no. ${agentCode}) on ${sim.msisdn}, owner ${fullName(person)}`);
  });
  return w.db.prepare("SELECT * FROM momo_agents WHERE code = ?").get(agentCode) as unknown as MomoAgentRow;
}

export function setMomoAgentStatus(w: World, telco: Telco, agentCode: string, status: "active" | "suspended") {
  const a = w.db.prepare("SELECT a.wallet_id FROM momo_agents a JOIN wallets w ON w.id = a.wallet_id WHERE a.code = ? AND w.telco = ?").get(agentCode, telco) as { wallet_id: string } | undefined;
  if (!a) throw new SimError("Agent not found");
  w.db.prepare("UPDATE momo_agents SET status = ? WHERE wallet_id = ?").run(status, a.wallet_id);
  audit(w, telco, "momo_agent", `Agent ${agentCode} set to ${status}`);
}

export function onboardMerchant(w: World, telco: Telco, input: { msisdn?: string; name?: string; category?: string; town?: string; pin?: string }) {
  const name = need(input.name?.trim(), "Business name");
  const town = need(input.town?.trim(), "Town");
  pinOk(input.pin);
  const { sim, person } = businessLine(w, telco, input.msisdn);
  const pin = acceptPin(w, sim.msisdn, input.pin, "merchant_line");
  verify(w, { requester: telco, purpose: "Merchant onboarding", card: person.ghana_card, biometric: false });
  const till = nextCode(w, "merchants", "till", 100000);
  tx(w.db, () => {
    const wallet = openWallet(w, sim, { pin, tier: "enhanced", ownerType: "merchant", displayName: name, by: "merchant onboarding" });
    w.db.prepare("INSERT INTO merchants(wallet_id, till, name, category, town, created_at) VALUES(?,?,?,?,?,?)").run(wallet.id, till, name, input.category?.trim() || "General", town, w.now);
    audit(w, telco, "merchant", `Onboarded merchant ${name} (merchant ID ${till}) on ${sim.msisdn}, owner ${fullName(person)}`);
  });
  return { till, name, msisdn: sim.msisdn };
}

/** Cash-in: the customer hands over cash and the agent sends the same amount of e-money from its float. Free to the customer. */
export function agentCashIn(w: World, telco: Telco, agentCode: unknown, input: { msisdn?: string; amount?: unknown; pin?: string }): Receipt {
  const a = momoAgent(w, telco, agentCode);
  const to = walletByMsisdn(w, normalizeMsisdn(String(need(input.msisdn, "Customer number"))));
  if (!to) throw new SimError("That number is not registered for mobile money");
  return walletPay(w, { type: "cashin", channel: "agent", from: a.wallet_id, to: to.id, amount: amountOf(input.amount), pin: String(input.pin ?? "") });
}

/**
 * Cash-out, step one: the agent checks the customer's ID (it must belong to the wallet owner) and
 * sends a withdrawal request. The customer then approves it on their own phone with their PIN.
 */
export function agentRequestCashOut(w: World, telco: Telco, agentCode: unknown, input: { msisdn?: string; amount?: unknown; card?: string }) {
  const a = momoAgent(w, telco, agentCode);
  const amount = amountOf(input.amount);
  const payer = ownWallet(w, telco, input.msisdn);
  const id = verify(w, { requester: telco, purpose: `Cash-out ID check at agent ${a.code}`, card: input.card, biometric: false });
  if (id.id !== payer.person_id) throw new SimError("The name on the ID does not match the name on the wallet. Cash-out refused.");
  if (a.cash < amount) throw new SimError("There is not enough cash in the till for this withdrawal");
  const r = createApproval(w, { kind: "cashout", payeeWallet: a.wallet_id, payerMsisdn: payer.msisdn, amount });
  audit(w, telco, "cashout_request", `Agent ${a.name} requested a cash-out of GHS ${cedis(amount)} from ${payer.msisdn}`);
  return r;
}

/** Agents rebalance by sending float to another agent on the same network. */
export function agentSendFloat(w: World, telco: Telco, agentCode: unknown, input: { toCode?: string; amount?: unknown; pin?: string }): Receipt {
  const a = momoAgent(w, telco, agentCode);
  const b = momoAgent(w, telco, need(input.toCode, "Receiving agent number"));
  return walletPay(w, { type: "float", channel: "agent", from: a.wallet_id, to: b.wallet_id, amount: amountOf(input.amount), pin: String(input.pin ?? "") });
}

/** The agent puts cash into, or takes cash out of, the till. Cash is physical: it is counted, not moved through the ledger. */
export function adjustTill(w: World, telco: Telco, agentCode: unknown, delta: number) {
  const a = momoAgent(w, telco, agentCode);
  if (a.cash + delta < 0) throw new SimError("There is not that much cash in the till");
  w.db.prepare("UPDATE momo_agents SET cash = cash + ? WHERE wallet_id = ?").run(delta, a.wallet_id);
}

export { telcoOf };
