import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sandbox-test-"));
process.env.SANDBOX_TEAMS = "2";

const { resetWorld } = await import("../src/engine/worlds");
const { enrol } = await import("../src/engine/nia");
const telco = await import("../src/engine/telco");
const { openAccount } = await import("../src/engine/bank");
const pay = await import("../src/engine/payments");
const { settle, positions } = await import("../src/engine/switch");
const { ussd } = await import("../src/engine/ussd");
const { balanceOf, walletByMsisdn, feeFor } = await import("../src/engine/ledger");
const { getConfig, setConfig, undoChange, applyPatch, validateSurface } = await import("../src/engine/config/store");
const { resolveSystem } = await import("../src/server/systems");
const { count } = await import("../src/engine/db");
const { defaultTelco } = await import("../src/engine/config/defaults");
type World = import("../src/engine/world").World;
type Person = import("../src/engine/nia").Person;

const person = (w: World, firstNames: string, surname: string, dob = "1990-05-17") => enrol(w, { firstNames, surname, dob, gender: "F", region: "Ashanti", town: "Kumasi" });
const lastSms = (w: World, msisdn: string) => (w.db.prepare("SELECT body FROM sms WHERE msisdn = ? ORDER BY id DESC LIMIT 1").get(msisdn) as { body: string }).body;
/** Walks a USSD session and returns the last screen. */
function dial(w: World, msisdn: string, ...inputs: string[]) {
  let sessionId: string | undefined;
  let last = { text: "", end: false, sessionId: "" };
  for (const input of inputs) {
    last = ussd(w, { sessionId, msisdn, input });
    sessionId = last.sessionId;
  }
  return last;
}
const view = <T>(w: World, ...p: string[]) => resolveSystem(p).view(w, new URLSearchParams()) as T;

describe("a country built from nothing", () => {
  let w: World;
  let ama: Person, kofi: Person, yaw: Person;
  let amaNo = "", kofiNo = "", yawAgentNo = "", yawTelecelNo = "";
  let mtnPoint = "", telecelPoint = "", mtnAgent = "", telecelAgent = "";
  let yawAccount = "";

  beforeAll(async () => {
    w = await resetWorld("team-01");
  });

  it("starts empty: institutions and settings, but no people, SIMs or money", () => {
    for (const table of ["persons", "sims", "wallets", "txns", "sim_agents", "momo_agents"]) expect(count(w.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM bank_accounts WHERE kind = 'trust'")).toBe(3);
    expect(getConfig(w.db, "telco.mtn").menu.shortcode).toBe("*170#");
  });

  it("NIA issues one Ghana Card per person", () => {
    ama = person(w, "Ama", "Owusu");
    kofi = person(w, "Kofi", "Mensah", "1985-01-02");
    yaw = person(w, "Yaw", "Asante", "1979-11-30");
    expect(ama.ghana_card).toMatch(/^GHA-\d{9}-\d$/);
    expect(() => person(w, "Ama", "Owusu")).toThrow(/already enrolled/);
  });

  it("a SIM cannot be registered without stock, an authorised point, and a biometric match", () => {
    expect(() => telco.registerSim(w, "mtn", "MTN-RA-0001", { card: ama.ghana_card, fingerprint: ama.fingerprint })).toThrow(/Unknown SIM registration point/);
    mtnPoint = telco.onboardSimAgent(w, "mtn", { card: yaw.ghana_card, name: "Adum Service Centre", kind: "service_centre", town: "Kumasi" }).id;
    expect(() => telco.registerSim(w, "mtn", mtnPoint, { card: ama.ghana_card, fingerprint: ama.fingerprint })).toThrow(/No blank SIMs/);
    telco.generateSims(w, "mtn", 5);
    expect(() => telco.registerSim(w, "mtn", mtnPoint, { card: ama.ghana_card, fingerprint: "FP-WRONG1" })).toThrow(/fingerprint does not match/);
    expect(() => telco.registerSim(w, "mtn", mtnPoint, { card: "GHA-000000000-0", fingerprint: "x" })).toThrow(/no Ghana Card/);
    amaNo = telco.registerSim(w, "mtn", mtnPoint, { card: ama.ghana_card, fingerprint: ama.fingerprint }).sim.msisdn;
    expect(lastSms(w, amaNo)).toMatch(/registered to Ama Owusu/);
    expect(dial(w, amaNo, "*400#").text).toMatch(/registered to Ama Owusu/);
    // Every check, pass or fail, is on NIA's log.
    expect(count(w.db, "SELECT COUNT(*) AS n FROM nia_log WHERE result = 'BIOMETRIC_MISMATCH'")).toBe(1);
  });

  it("a second SIM on the same card needs a code sent to the primary number", () => {
    yawAgentNo = telco.registerSim(w, "mtn", mtnPoint, { card: yaw.ghana_card, fingerprint: yaw.fingerprint }).sim.msisdn;
    telco.generateSims(w, "telecel", 5);
    telecelPoint = telco.onboardSimAgent(w, "telecel", { card: kofi.ghana_card, name: "Kejetia Registration Agent", kind: "registration_agent", town: "Kumasi" }).id;
    expect(() => telco.registerSim(w, "telecel", telecelPoint, { card: yaw.ghana_card, fingerprint: yaw.fingerprint })).toThrow(/approval code was sent/);
    const otp = lastSms(w, yawAgentNo).match(/is (\d{6})/)![1];
    expect(() => telco.registerSim(w, "telecel", telecelPoint, { card: yaw.ghana_card, fingerprint: yaw.fingerprint, otp: "000000" })).toThrow(/Wrong approval code/);
    yawTelecelNo = telco.registerSim(w, "telecel", telecelPoint, { card: yaw.ghana_card, fingerprint: yaw.fingerprint, otp }).sim.msisdn;
    kofiNo = telco.registerSim(w, "telecel", telecelPoint, { card: kofi.ghana_card, fingerprint: kofi.fingerprint }).sim.msisdn;
    expect(dial(w, yawAgentNo, "*402*1#").text).toMatch(/\(2\)/);
  });

  it("the NCA limit on SIMs per Ghana Card is enforced", () => {
    setConfig(w.db, "nca", { ...getConfig(w.db, "nca"), maxSimsPerCard: 1, primaryNumberApproval: false }, "test", "api");
    expect(() => telco.registerSim(w, "mtn", mtnPoint, { card: ama.ghana_card, fingerprint: ama.fingerprint })).toThrow(/maximum across all networks/);
    setConfig(w.db, "nca", { ...getConfig(w.db, "nca"), maxSimsPerCard: 10, primaryNumberApproval: true }, "test", "api");
  });

  it("a subscriber opens a wallet from the phone on MTN, but Telecel sends them to an agent", () => {
    expect(dial(w, amaNo, "*170#").text).toMatch(/no wallet yet/);
    expect(dial(w, amaNo, "*170#", "1", "1234", "1234").text).toMatch(/now registered/);
    expect(walletByMsisdn(w, amaNo)!.kyc_tier).toBe("minimum");
    expect(dial(w, amaNo, "*170#").text).toMatch(/^MTN MoMo\n1\) Transfer Money/);
    expect(dial(w, kofiNo, "*110#").text).toMatch(/Visit a Telecel Cash agent/);
  });

  it("telcos onboard mobile money agents on dedicated lines; agents register customers on medium KYC", () => {
    expect(() => telco.onboardMomoAgent(w, "mtn", { msisdn: amaNo, name: "X", town: "Kumasi", pin: "1111" })).toThrow(/dedicated SIM line/);
    mtnAgent = telco.onboardMomoAgent(w, "mtn", { msisdn: yawAgentNo, name: "Yaw Mobile Money Centre", town: "Suame", pin: "4321" }).code;
    telecelAgent = telco.onboardMomoAgent(w, "telecel", { msisdn: yawTelecelNo, name: "Yaw Telecel Cash Point", town: "Suame", pin: "4321" }).code;
    expect(() => telco.agentRegisterWallet(w, "telecel", telecelAgent, { msisdn: kofiNo, card: ama.ghana_card, fingerprint: ama.fingerprint, pin: "2222" })).toThrow(/does not belong to the registered owner/);
    expect(telco.agentRegisterWallet(w, "telecel", telecelAgent, { msisdn: kofiNo, card: kofi.ghana_card, fingerprint: kofi.fingerprint, pin: "2222" }).kyc_tier).toBe("medium");
  });

  it("money enters through a bank: deposit, then float pushed to the agent line through the switch", () => {
    expect(() => telco.agentCashIn(w, "mtn", mtnAgent, { msisdn: amaNo, amount: 100, pin: "4321" })).toThrow(/insufficient float/);
    yawAccount = openAccount(w, "gcb", { card: yaw.ghana_card, fingerprint: yaw.fingerprint }).id;
    pay.bankCash(w, { bank: "gcb", account: yawAccount, amount: 800000, kind: "deposit" });
    pay.bankToWallet(w, { bank: "gcb", fromAccount: yawAccount, msisdn: yawAgentNo, amount: 300000 });
    pay.bankToWallet(w, { bank: "gcb", fromAccount: yawAccount, msisdn: yawTelecelNo, amount: 100000 });
    expect(walletByMsisdn(w, yawAgentNo)!.balance).toBe(300000);
    expect(balanceOf(w, "switch:gcb")).toBe(400000);
    expect(balanceOf(w, "switch:mtn")).toBe(-300000);
  });

  it("cash-in is free to the customer and pays the agent a commission", () => {
    expect(() => telco.agentCashIn(w, "mtn", mtnAgent, { msisdn: amaNo, amount: 500, pin: "0000" })).toThrow(/Wrong PIN/);
    telco.agentCashIn(w, "mtn", mtnAgent, { msisdn: amaNo, amount: 500, pin: "4321" });
    expect(walletByMsisdn(w, amaNo)!.balance).toBe(50000);
    const commission = feeFor(getConfig(w.db, "telco.mtn").agentCommission.cashin, 50000);
    expect(walletByMsisdn(w, yawAgentNo)!.balance).toBe(300000 - 50000 + commission);
    expect(telco.momoAgent(w, "mtn", mtnAgent).cash).toBe(50000);
    expect(lastSms(w, amaNo)).toMatch(/Cash in of GHS 500.00/);
  });

  it("a cross-network transfer from the phone is routed and logged by the switch", () => {
    const r = dial(w, amaNo, "*170#", "1", "2", kofiNo, kofiNo, "100", "rent", "1234");
    expect(r.text).toMatch(/GHS 100.00 sent to Kofi Mensah. Fee GHS 0.75/);
    expect(walletByMsisdn(w, amaNo)!.balance).toBe(50000 - 10075);
    expect(walletByMsisdn(w, kofiNo)!.balance).toBe(10000);
    const steps = (w.db.prepare("SELECT step FROM switch_log WHERE from_party = 'mtn' AND to_party = 'telecel' ORDER BY id").all() as { step: string }[]).map((s) => s.step);
    expect(steps).toEqual(["lookup", "quote", "commit"]);
    expect(lastSms(w, kofiNo)).toMatch(/Payment received for GHS 100.00 from Ama Owusu/);
  });

  it("the switch refuses payments to a disconnected participant", () => {
    resolveSystem(["switch"]).actions.connect(w, { participant: "telecel", connected: false });
    expect(dial(w, amaNo, "*170#", "1", "2", kofiNo, kofiNo, "10", "x", "1234").text).toMatch(/Telecel Cash is disconnected/);
    resolveSystem(["switch"]).actions.connect(w, { participant: "telecel", connected: true });
    expect(count(w.db, "SELECT COUNT(*) AS n FROM txns WHERE status = 'failed' AND reason LIKE '%disconnected%'")).toBe(1);
  });

  it("cash-out: the agent checks the ID and asks, the customer approves on their phone", () => {
    expect(() => telco.agentRequestCashOut(w, "mtn", mtnAgent, { msisdn: amaNo, amount: 200, card: kofi.ghana_card })).toThrow(/does not match the name on the wallet/);
    telco.agentRequestCashOut(w, "mtn", mtnAgent, { msisdn: amaNo, amount: 200, card: ama.ghana_card });
    const before = walletByMsisdn(w, amaNo)!.balance;
    expect(dial(w, amaNo, "*170#", "4").text).toMatch(/Cash out GHS 200.00 at Yaw Mobile Money Centre/);
    expect(dial(w, amaNo, "*170#", "4", "1", "1", "1234").text).toMatch(/cashed out at Yaw Mobile Money Centre. Fee GHS 2.00/);
    expect(walletByMsisdn(w, amaNo)!.balance).toBe(before - 20200);
    expect(telco.momoAgent(w, "mtn", mtnAgent).cash).toBe(30000);
    expect(dial(w, amaNo, "*170#", "4").text).toMatch(/no pending approvals/);
  });

  it("Bank of Ghana KYC limits apply by tier", () => {
    pay.bankToWallet(w, { bank: "gcb", fromAccount: yawAccount, msisdn: amaNo, amount: 350000 });
    expect(dial(w, amaNo, "*170#", "1", "2", kofiNo, kofiNo, "3100", "big", "1234").text).toMatch(/daily limit of GHS 3000 \(minimum KYC\)/);
    // An in-person visit to an agent lifts the wallet to medium KYC and the same payment goes through.
    telco.agentRegisterWallet(w, "mtn", mtnAgent, { msisdn: amaNo, card: ama.ghana_card, fingerprint: ama.fingerprint });
    expect(walletByMsisdn(w, amaNo)!.kyc_tier).toBe("medium");
    expect(dial(w, amaNo, "*170#", "1", "2", kofiNo, kofiNo, "3100", "big", "1234").text).toMatch(/GHS 3100.00 sent/);
    expect(() => pay.bankToWallet(w, { bank: "gcb", msisdn: amaNo, amount: 5000000 })).toThrow(/balance limit of GHS 40000/);
  });

  it("three wrong PINs lock the wallet until a service centre resets it", () => {
    for (let i = 0; i < 2; i++) expect(dial(w, kofiNo, "*110#", "6", "1", "9999").text).toMatch(/attempt\(s\) left/);
    expect(dial(w, kofiNo, "*110#", "6", "1", "9999").text).toMatch(/now locked/);
    expect(dial(w, kofiNo, "*110#", "6", "1", "2222").text).toMatch(/locked/);
    telco.resetPin(w, "telecel", telecelPoint, { msisdn: kofiNo, card: kofi.ghana_card, fingerprint: kofi.fingerprint });
    const temp = lastSms(w, kofiNo).match(/temporary PIN is (\d{4})/)![1];
    expect(dial(w, kofiNo, "*110#", "6", "1", temp).text).toMatch(/balance is GHS/);
  });

  it("after a SIM replacement the wallet cannot send for the hold period", () => {
    telco.swapSim(w, "telecel", telecelPoint, { msisdn: kofiNo, card: kofi.ghana_card, fingerprint: kofi.fingerprint });
    const pin = walletByMsisdn(w, kofiNo)!.pin;
    expect(dial(w, kofiNo, "*110#", "1", "2", amaNo, amaNo, "5", "x", pin).text).toMatch(/paused for 24 hours after a SIM swap/);
    setConfig(w.db, "telco.telecel", applyPatch(getConfig(w.db, "telco.telecel"), [{ op: "replace", path: "/simSwapMomoHoldHours", value: 0 }]), "No hold", "api");
    expect(dial(w, kofiNo, "*110#", "1", "2", amaNo, amaNo, "5", "x", pin).text).toMatch(/GHS 5.00 sent to Ama Owusu/);
  });

  it("a blocked SIM has no service", () => {
    telco.setSimStatus(w, "mtn", mtnPoint, amaNo, "blocked", "lost");
    expect(dial(w, amaNo, "*170#").text).toMatch(/SIM is blocked/);
    telco.setSimStatus(w, "mtn", mtnPoint, amaNo, "active");
  });

  it("a telco can reverse its own wallet payment", () => {
    const before = walletByMsisdn(w, amaNo)!.balance;
    const r = pay.walletPay(w, { type: "p2p", channel: "console", from: `w_${amaNo}`, to: `w_${yawAgentNo}`, amount: 2000 });
    expect(() => pay.reverse(w, "telecel", r.txnId)).toThrow(/Only the sending network/);
    pay.reverse(w, "mtn", r.txnId);
    expect(walletByMsisdn(w, amaNo)!.balance).toBe(before);
  });

  it("wallet to bank, then settlement moves real money and every issuer stays fully backed", () => {
    const acct = openAccount(w, "ecobank", { card: ama.ghana_card, fingerprint: ama.fingerprint });
    // To her own bank account it is free; to someone else's the wallet-to-bank fee applies.
    expect(dial(w, amaNo, "*170#", "1", "3", acct.account_no, "50").text).toMatch(/Fee: GHS0.00/);
    expect(dial(w, amaNo, "*170#", "1", "3", acct.account_no, "50", "1234").text).toMatch(/GHS 50.00 sent to Ama Owusu \(Ecobank Ghana\). Fee GHS 0.00/);
    const yawNo = (w.db.prepare("SELECT account_no FROM bank_accounts WHERE id = ?").get(yawAccount) as { account_no: string }).account_no;
    expect(dial(w, amaNo, "*170#", "1", "3", yawNo, "200").text).toMatch(/Fee: GHS1.50/);
    expect(dial(w, amaNo, "*170#", "1", "3", yawNo, "200", "1234").text).toMatch(/GHS 200.00 sent to Yaw Asante \(GCB Bank\). Fee GHS 1.50/);
    setConfig(w.db, "telco.mtn", { ...getConfig(w.db, "telco.mtn"), ownBankAccountFree: false }, "Charge own-account transfers", "api");
    expect(dial(w, amaNo, "*170#", "1", "3", acct.account_no, "200").text).toMatch(/Fee: GHS1.50/);
    setConfig(w.db, "telco.mtn", { ...getConfig(w.db, "telco.mtn"), ownBankAccountFree: true }, "Free again", "api");
    type Bog = { issuers: { telco: string; backed: boolean; trustBalance: number; eMoney: number; unsettled: number }[]; ledgerBalanced: boolean };
    let bog = view<Bog>(w, "bog");
    expect(bog.issuers.every((i) => i.backed)).toBe(true);
    expect(bog.issuers.find((i) => i.telco === "mtn")!.trustBalance).toBe(0);

    settle(w);
    expect(positions(w).every((p) => p.position === 0)).toBe(true);
    bog = view<Bog>(w, "bog");
    for (const i of bog.issuers) {
      expect(i.backed).toBe(true);
      expect(i.trustBalance).toBe(i.eMoney); // nothing left unsettled: the trust account alone backs the e-money
    }
    expect(bog.ledgerBalanced).toBe(true);
    // Banks' settlement accounts at the central bank net to zero.
    expect(["gcb", "ecobank", "fidelity", "calbank", "absa", "stanbic"].reduce((s, b) => s + balanceOf(w, `reserve:${b}`), 0)).toBe(0);
    expect(() => settle(w)).toThrow(/Nothing to settle/);
  });

  it("every console view renders", () => {
    for (const p of [["hub"], ["nia"], ["telco", "mtn"], ["sim-agent", "telecel"], ["momo-agent", "mtn"], ["phone"], ["bank", "gcb"], ["switch"], ["bog"], ["nca"]]) expect(view(w, ...p)).toBeTruthy();
    const phone = resolveSystem(["phone"]).view(w, new URLSearchParams({ msisdn: amaNo })) as { phone: { wallet: { tier: string } } };
    expect(phone.phone.wallet.tier).toBe("medium");
  });

  it("settings are validated, recorded and can be undone", () => {
    const before = getConfig(w.db, "bog").kycTiers.minimum.daily;
    const id = setConfig(w.db, "bog", applyPatch(getConfig(w.db, "bog"), [{ op: "replace", path: "/kycTiers/minimum/daily", value: 1000 }]), "Lower the minimum daily limit", "api");
    expect(getConfig(w.db, "bog").kycTiers.minimum.daily).toBe(1000);
    undoChange(w.db, id, "api");
    expect(getConfig(w.db, "bog").kycTiers.minimum.daily).toBe(before);
    const bad = validateSurface("telco.mtn", { ...getConfig(w.db, "telco.mtn"), menu: { ...getConfig(w.db, "telco.mtn").menu, start: "nope" } });
    expect(bad.ok).toBe(false);
  });

  it("worlds are isolated and reset to empty", async () => {
    const other = await resetWorld("team-02");
    expect(count(other.db, "SELECT COUNT(*) AS n FROM persons")).toBe(0);
    w = await resetWorld("team-01");
    expect(count(w.db, "SELECT COUNT(*) AS n FROM persons")).toBe(0);
  });
});

describe("fees", () => {
  const fee = (t: "mtn" | "telecel" | "at", kind: "p2p_onnet" | "p2p_offnet" | "cashout" | "merchant" | "to_bank", amount: number) => feeFor(defaultTelco(t).fees[kind], amount * 100) / 100;

  it("applies the MTN tariff (AT uses the same)", () => {
    for (const t of ["mtn", "at"] as const) {
      expect(fee(t, "p2p_onnet", 200)).toBe(1.5);
      expect(fee(t, "p2p_onnet", 5000)).toBe(7.5);
      expect(fee(t, "cashout", 30)).toBe(0.5);
      expect(fee(t, "cashout", 500)).toBe(5);
      expect(fee(t, "cashout", 3000)).toBe(20);
      expect(fee(t, "merchant", 800)).toBe(0);
      expect(fee(t, "to_bank", 2000)).toBe(5);
    }
  });

  it("applies the Telecel tariff", () => {
    expect(fee("telecel", "p2p_onnet", 900)).toBe(0);
    expect(fee("telecel", "p2p_offnet", 80)).toBe(0);
    expect(fee("telecel", "p2p_offnet", 400)).toBe(2);
    expect(fee("telecel", "p2p_offnet", 2500)).toBe(5);
    expect(fee("telecel", "cashout", 2000)).toBe(20);
  });
});
