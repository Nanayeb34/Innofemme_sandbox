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
/** The payment totals the database keeps as it goes, beside a fresh count of the whole history: the two must agree. */
const totals = (w: World) => ({
  kept: w.db.prepare("SELECT status, type, rail, from_party AS f, to_party AS t, n, amount FROM txn_totals WHERE n != 0 OR amount != 0 ORDER BY 1, 2, 3, 4, 5").all(),
  counted: w.db.prepare("SELECT status, type, rail, COALESCE(from_party, '') AS f, COALESCE(to_party, '') AS t, COUNT(*) AS n, SUM(amount) AS amount FROM txns GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5").all(),
});

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

  it("a subscriber opens a wallet from the phone: on MTN from the wallet's code, on Telecel from its own registration code", () => {
    expect(dial(w, amaNo, "*170#").text).toMatch(/no wallet yet/);
    expect(dial(w, amaNo, "*170#", "1", "1234", "1234").text).toMatch(/now registered/);
    expect(walletByMsisdn(w, amaNo)!.kyc_tier).toBe("minimum");
    expect(dial(w, amaNo, "*170#").text).toMatch(/^MTN MoMo\n1\) Transfer Money/);
    expect(dial(w, kofiNo, "*110#").text).toMatch(/Dial \*558# to register, or visit a Telecel Cash agent/);
    expect(dial(w, kofiNo, "*558#").text).toMatch(/no wallet yet\.\n1\) Register now/);
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
    // A PIN the network issued must be replaced before the wallet can be used: the menu does not open until it is.
    expect(dial(w, kofiNo, "*110#").text).toMatch(/Enter the PIN sent to you by SMS/);
    expect(dial(w, kofiNo, "*110#", "0000").text).toMatch(/Wrong PIN/);
    expect(dial(w, kofiNo, "*110#", temp, temp).text).toMatch(/different from the one sent to you/);
    expect(dial(w, kofiNo, "*110#", temp, "6802", "6802").text).toMatch(/Your PIN is set/);
    expect(dial(w, kofiNo, "*110#", "6", "1", temp).text).toMatch(/Wrong PIN/);
    expect(dial(w, kofiNo, "*110#", "6", "1", "6802").text).toMatch(/balance is GHS/);
  });

  it("after a SIM replacement the wallet cannot send for the hold period", () => {
    telco.swapSim(w, "telecel", telecelPoint, { msisdn: kofiNo, card: kofi.ghana_card, fingerprint: kofi.fingerprint });
    const pin = walletByMsisdn(w, kofiNo)!.pin;
    expect(dial(w, kofiNo, "*110#", "1", "2", amaNo, "5", "x", pin).text).toMatch(/paused for 24 hours after a SIM swap/);
    setConfig(w.db, "telco.telecel", applyPatch(getConfig(w.db, "telco.telecel"), [{ op: "replace", path: "/simSwapMomoHoldHours", value: 0 }]), "No hold", "api");
    expect(dial(w, kofiNo, "*110#", "1", "2", amaNo, "5", "x", pin).text).toMatch(/GHS 5.00 sent to Ama Owusu/);
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

describe("voice calls", () => {
  it("plays the network: switched off, ringing, busy, answered, ended, and the call log", async () => {
    const calls = await import("../src/engine/calls");
    const w = await resetWorld("team-02");
    const a = person(w, "Esi", "Arthur");
    const b = person(w, "Kojo", "Annan", "1991-02-03");
    const c = person(w, "Efua", "Eshun", "1992-04-05");
    telco.generateSims(w, "mtn", 3);
    telco.generateSims(w, "at", 1);
    const mtn = telco.onboardSimAgent(w, "mtn", { card: a.ghana_card, name: "Point", kind: "service_centre", town: "Accra" }).id;
    const at = telco.onboardSimAgent(w, "at", { card: a.ghana_card, name: "Point", kind: "service_centre", town: "Accra" }).id;
    const [na, nb] = [a, b].map((p) => telco.registerSim(w, "mtn", mtn, { card: p.ghana_card, fingerprint: p.fingerprint }).sim.msisdn);
    const nc = telco.registerSim(w, "at", at, { card: c.ghana_card, fingerprint: c.fingerprint }).sim.msisdn;
    const on = (msisdn: string, device: string, extra = {}) => calls.pollCall(w, { msisdn, device, ...extra });

    expect(() => calls.startCall(w, { from: na, to: "0240000000", device: "A", offer: "o" })).toThrow(/not in service/);
    expect(() => calls.startCall(w, { from: na, to: na, device: "A", offer: "o" })).toThrow(/your own number/);
    // Nobody has Kojo's phone open: it is off, and the network texts him about the missed call.
    expect(() => calls.startCall(w, { from: na, to: nb, device: "A", offer: "o" })).toThrow(/switched off/);
    expect(lastSms(w, nb)).toMatch(/You missed a call from/);

    on(nb, "B");
    on(nc, "C");
    const { id } = calls.startCall(w, { from: na, to: nb, device: "A", offer: "offer-sdp" });
    expect(on(nb, "B").call).toMatchObject({ role: "callee", status: "ringing", peer: na, offer: "offer-sdp" });
    // A third phone, on another network, gets the busy tone.
    expect(() => calls.startCall(w, { from: nc, to: nb, device: "C", offer: "o" })).toThrow(/busy/);
    // The caller's network paths reach the other phone; each side only gets what it has not seen.
    on(na, "A", { callId: id, candidates: [{ candidate: "c1" }, { candidate: "c2" }] });
    expect(on(nb, "B", { have: 1 }).call!.candidates).toEqual([{ candidate: "c2" }]);

    calls.answerCall(w, { callId: id, msisdn: nb, device: "B", answer: "answer-sdp" });
    expect(on(na, "A", { callId: id }).call).toMatchObject({ status: "active", answer: "answer-sdp" });
    // The same number open on another screen does not take over the call.
    expect(on(nb, "B2")).toEqual({ call: null, elsewhere: true });
    expect(() => calls.answerCall(w, { callId: id, msisdn: nb, device: "B2", answer: "x" })).toThrow(/no longer ringing/);

    calls.endCall(w, { callId: id, msisdn: na });
    expect(on(nb, "B", { callId: id }).call).toMatchObject({ status: "ended" });
    expect(on(nb, "B").call).toBeNull();

    // Declined, then a blocked SIM on each side.
    const second = calls.startCall(w, { from: nb, to: na, device: "B", offer: "o" }).id;
    calls.endCall(w, { callId: second, msisdn: na });
    expect(on(nb, "B", { callId: second }).call).toMatchObject({ status: "declined", reason: "Call declined" });
    telco.setSimStatus(w, "mtn", mtn, na, "blocked", "lost");
    expect(() => calls.startCall(w, { from: na, to: nb, device: "A", offer: "o" })).toThrow(/No network service/);
    expect(() => calls.startCall(w, { from: nb, to: na, device: "B", offer: "o" })).toThrow(/switched off/);

    expect(calls.callLog(w, nb).map((x) => `${x.direction}:${x.status}`)).toEqual(["outgoing:failed", "outgoing:declined", "missed:busy", "incoming:ended", "missed:missed"]);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM calls WHERE from_telco = 'at' AND to_telco = 'mtn' AND status = 'busy'")).toBe(1);
  });
});

describe("customer care", () => {
  it("handles tickets and disputes: hold, consent, return, across networks, and calls to 100", async () => {
    const care = await import("../src/engine/care");
    const calls = await import("../src/engine/calls");
    const w = await resetWorld("team-02");
    const people = [person(w, "Abena", "Darko"), person(w, "Kwesi", "Ofori", "1986-06-06"), person(w, "Naa", "Lartey", "1993-09-09"), person(w, "Yaw", "Kumi", "1975-01-01")];
    telco.generateSims(w, "mtn", 4);
    telco.generateSims(w, "at", 2);
    const mtnPoint = telco.onboardSimAgent(w, "mtn", { card: people[3].ghana_card, name: "Point", kind: "service_centre", town: "Accra" }).id;
    const atPoint = telco.onboardSimAgent(w, "at", { card: people[3].ghana_card, name: "Point", kind: "service_centre", town: "Accra" }).id;
    const reg = (t: "mtn" | "at", point: string, p: Person) => telco.registerSim(w, t, point, { card: p.ghana_card, fingerprint: p.fingerprint }).sim.msisdn;
    const [a, b] = [reg("mtn", mtnPoint, people[0]), reg("mtn", mtnPoint, people[1])];
    const c = reg("at", atPoint, people[2]);
    const agentLine = reg("mtn", mtnPoint, people[3]);
    dial(w, a, "*170#", "1", "1111", "1111");
    dial(w, b, "*170#", "1", "2222", "2222");
    dial(w, c, "*110#", "1", "3333", "3333");
    const agent = telco.onboardMomoAgent(w, "mtn", { msisdn: agentLine, name: "Kumi MoMo", town: "Accra", pin: "4444" }).code;
    pay.bankToWallet(w, { bank: "gcb", msisdn: a, amount: 100000 });
    pay.bankToWallet(w, { bank: "gcb", msisdn: agentLine, amount: 100000 });
    const bal = (m: string) => walletByMsisdn(w, m)!.balance;
    const send = (from: string, to: string, ghs: number) => pay.walletPay(w, { type: "p2p", channel: "ussd", from: `w_${from}`, to: `w_${to}`, amount: ghs * 100 });
    const backed = () => (resolveSystem(["bog"]).view(w, new URLSearchParams()) as { issuers: { backed: boolean }[] }).issuers.every((i) => i.backed);
    const by = "care";

    // 1. Same network. The customer reports it from the phone; care holds the money and sends it back, fee included.
    const start = bal(a);
    const t1 = send(a, b, 100);
    expect(bal(a)).toBe(start - 10075);
    expect(dial(w, a, "*170#", "6", "4", "1", "1").text).toMatch(/Ticket MTN-000001/);
    expect(lastSms(w, a)).toMatch(/opened ticket MTN-000001/);
    expect(() => pay.reverse(w, "mtn", t1.txnId)).toThrow(/dispute in customer care/);
    expect(() => care.returnFunds(w, "mtn", "MTN-000001", by)).toThrow(/Nothing is on hold/);
    expect(care.placeHold(w, "mtn", "MTN-000001", by)).toBe(10000);
    expect(bal(b)).toBe(0);
    expect(lastSms(w, b)).toMatch(/on hold while a wrong-transfer claim is checked/);
    expect(backed()).toBe(true);
    expect(() => care.closeTicket(w, "mtn", "MTN-000001", by, { outcome: "resolved", resolution: "x" })).toThrow(/still on hold/);
    expect(care.returnFunds(w, "mtn", "MTN-000001", by)).toEqual({ returned: 10000, full: true });
    expect(bal(a)).toBe(start);
    expect(care.getTicket(w, "MTN-000001")!.status).toBe("resolved");
    expect(lastSms(w, a)).toMatch(/Ticket MTN-000001 is closed: Money returned to the sender in full/);
    expect(() => care.openTicket(w, "mtn", { msisdn: a, category: "wrong_transfer", txnId: t1.txnId, channel: "call", by })).toThrow(/is reversed/);

    // 2. The recipient has already spent part of it: only what is left can be recovered.
    const t2 = send(a, b, 100);
    send(b, a, 60);
    const k2 = care.openTicket(w, "mtn", { msisdn: a, category: "wrong_transfer", txnId: t2.txnId, channel: "call", by });
    expect(care.placeHold(w, "mtn", k2.id, by)).toBe(3955); // GHS 100 less the 60 sent on and its 0.45 fee
    expect(care.returnFunds(w, "mtn", k2.id, by)).toEqual({ returned: 3955, full: false });
    expect(care.getTicket(w, k2.id)!.status).toBe("open");
    care.closeTicket(w, "mtn", k2.id, by, { outcome: "resolved", resolution: "GHS 39.55 recovered; the rest was spent" });

    // 3. The recipient is asked on their phone. Refusing hands it back to care; agreeing returns the money.
    pay.bankToWallet(w, { bank: "gcb", msisdn: b, amount: 20000 });
    const t3 = send(a, b, 50);
    const k3 = care.openTicket(w, "mtn", { msisdn: a, category: "wrong_transfer", txnId: t3.txnId, channel: "call", by });
    care.requestConsent(w, "mtn", k3.id, by);
    expect(care.getTicket(w, k3.id)!.status).toBe("awaiting_recipient");
    expect(dial(w, b, "*170#", "4").text).toMatch(/Return GHS 50.00 to Abena Darko \(sent by mistake\)/);
    expect(dial(w, b, "*170#", "4", "1", "2").text).toMatch(/You have refused/);
    expect(care.getTicket(w, k3.id)!.status).toBe("open");
    care.requestConsent(w, "mtn", k3.id, by);
    const before = bal(a);
    expect(dial(w, b, "*170#", "4", "1", "1", "2222").text).toMatch(/GHS 50.00 has been returned to the sender/);
    expect(bal(a)).toBe(before + 5000 + 38);
    expect(care.getTicket(w, k3.id)!.status).toBe("resolved");
    expect(dial(w, b, "*170#", "4").text).toMatch(/no pending approvals/);

    // 4. Another network. Only the recipient's network can touch the money, so the dispute goes through the switch.
    const t4 = send(a, c, 80);
    const k4 = care.openTicket(w, "mtn", { msisdn: a, category: "wrong_transfer", txnId: t4.txnId, channel: "call", by });
    expect(() => care.placeHold(w, "mtn", k4.id, by)).toThrow(/Send the dispute to that network/);
    const theirs = care.forwardDispute(w, "mtn", k4.id, by);
    expect(theirs).toMatchObject({ id: "AT-000001", telco: "at", role: "recipient", msisdn: c, linked_ticket: k4.id });
    expect(care.getTicket(w, k4.id)!.status).toBe("with_other_network");
    expect(() => care.closeTicket(w, "mtn", k4.id, by, { outcome: "rejected", resolution: "x" })).toThrow(/with the other network/);
    expect(() => care.placeHold(w, "mtn", theirs.id, by)).toThrow(/not found on this network/);
    care.placeHold(w, "at", theirs.id, by);
    const beforeCross = bal(a);
    const owed = balanceOf(w, "switch:mtn");
    expect(care.returnFunds(w, "at", theirs.id, by).full).toBe(true);
    expect(bal(a)).toBe(beforeCross + 8000 + 60);
    expect(balanceOf(w, "switch:mtn")).toBe(owed - 8000); // the money came back through the switch
    expect(care.getTicket(w, k4.id)).toMatchObject({ status: "resolved", resolution: "Money returned to the sender in full" });
    expect(count(w.db, "SELECT COUNT(*) AS n FROM switch_log WHERE step = 'dispute'")).toBe(1);
    expect(backed()).toBe(true);

    // 5. The other network rejects the claim: the hold is released and the sender is told.
    const t5 = send(a, c, 30);
    const k5 = care.openTicket(w, "mtn", { msisdn: a, category: "unauthorised", txnId: t5.txnId, channel: "call", by });
    const theirs5 = care.forwardDispute(w, "mtn", k5.id, by);
    care.placeHold(w, "at", theirs5.id, by);
    const cBefore = bal(c);
    care.closeTicket(w, "at", theirs5.id, by, { outcome: "rejected", resolution: "The recipient showed the payment was for goods" });
    expect(bal(c)).toBe(cBefore + 3000);
    expect(care.getTicket(w, k5.id)!.status).toBe("rejected");
    expect(lastSms(w, a)).toMatch(/is closed: rejected. The recipient showed/);

    // 6. A cash-out the customer disputes is reversed in full, including the agent's till and commission.
    telco.adjustTill(w, "mtn", agent, 50000);
    telco.agentRequestCashOut(w, "mtn", agent, { msisdn: a, amount: 100, card: people[0].ghana_card });
    const beforeOut = bal(a);
    dial(w, a, "*170#", "4", "1", "1", "1111");
    expect(bal(a)).toBe(beforeOut - 10100);
    expect(dial(w, a, "*170#", "6", "4", "1", "1").text).toMatch(/Ticket MTN-/);
    const k6 = (w.db.prepare("SELECT id FROM tickets WHERE category = 'agent_complaint'").get() as { id: string }).id;
    care.reverseAgentTransaction(w, "mtn", k6, by);
    expect(bal(a)).toBe(beforeOut);
    expect(telco.momoAgent(w, "mtn", agent).cash).toBe(50000);

    // 7. Calling 100 reaches the caller's own network's care line, when an agent is on line.
    expect(() => calls.startCall(w, { from: a, to: "100", device: "A", offer: "o" })).toThrow(/customer care is closed/);
    const mtnCare = calls.careEndpoint("mtn");
    calls.pollCall(w, { msisdn: mtnCare, device: "agent-1" });
    const first = calls.startCall(w, { from: a, to: "100", device: "A", offer: "o1" }).id;
    const second = calls.startCall(w, { from: b, to: "100", device: "B", offer: "o2" }).id;
    expect(calls.careQueue(w, "mtn")).toBe(2);
    expect(calls.pollCall(w, { msisdn: mtnCare, device: "agent-1" }).call).toMatchObject({ id: first, role: "callee", peer: a, offer: "o1" });
    calls.answerCall(w, { callId: first, msisdn: mtnCare, device: "agent-1", answer: "ans" });
    expect(calls.pollCall(w, { msisdn: a, device: "A", callId: first }).call).toMatchObject({ status: "active", peer: "100", peerNetwork: "MTN customer care" });
    // A second agent gets the next caller in the queue; the first stays on their own call.
    expect(calls.pollCall(w, { msisdn: mtnCare, device: "agent-2" }).call!.id).toBe(second);
    expect(calls.pollCall(w, { msisdn: mtnCare, device: "agent-1" }).call!.id).toBe(first);
    calls.endCall(w, { callId: first, msisdn: mtnCare });
    expect(calls.pollCall(w, { msisdn: a, device: "A", callId: first }).call!.status).toBe("ended");
    // An AT customer's 100 goes to AT, where nobody is on line.
    expect(() => calls.startCall(w, { from: c, to: "100", device: "C", offer: "o" })).toThrow(/AT customer care is closed/);

    // The care console's own view of all this.
    type CareView = { tickets: { id: string }[]; ticket: { can: Record<string, boolean>; events: unknown[] } | null; customer: { found: boolean; identity: { name: string } } | null };
    const v = resolveSystem(["care", "mtn"]).view(w, new URLSearchParams({ ticket: k4.id, customer: a })) as CareView;
    expect(v.tickets.length).toBe(6);
    expect(v.ticket!.can.close).toBe(false);
    expect(v.customer).toMatchObject({ found: true, identity: { name: "Abena Darko" } });
    expect(count(w.db, "SELECT COUNT(*) AS n FROM (SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount) != 0)")).toBe(0);
    // Payments were made, refused and reversed here: the running totals kept pace with all of it.
    expect(totals(w).kept).toEqual(totals(w).counted);
    expect(totals(w).counted.some((r) => r.status === "reversed")).toBe(true);
  });
});

describe("text messages", () => {
  it("delivers person-to-person and business texts, keeps threads, and records everything", async () => {
    const sms = await import("../src/engine/sms");
    const w = await resetWorld("team-02");
    const [a, b, c] = [person(w, "Adwoa", "Bonsu"), person(w, "Kwabena", "Osei", "1984-04-04"), person(w, "Dzifa", "Agbeko", "1996-06-06")];
    telco.generateSims(w, "mtn", 4);
    telco.generateSims(w, "telecel", 2);
    const mtn = telco.onboardSimAgent(w, "mtn", { card: a.ghana_card, name: "Point", kind: "service_centre", town: "Ho" }).id;
    const tel = telco.onboardSimAgent(w, "telecel", { card: a.ghana_card, name: "Point", kind: "service_centre", town: "Ho" }).id;
    const na = telco.registerSim(w, "mtn", mtn, { card: a.ghana_card, fingerprint: a.fingerprint }).sim.msisdn;
    const nb = telco.registerSim(w, "telecel", tel, { card: b.ghana_card, fingerprint: b.fingerprint }).sim.msisdn;
    const shopLine = telco.registerSim(w, "mtn", mtn, { card: c.ghana_card, fingerprint: c.fingerprint }).sim.msisdn;

    // Across networks, and it waits in the inbox whether or not the phone is open.
    expect(sms.sendText(w, { from: na, to: nb, text: "Hello Kwabena" })).toMatchObject({ delivered: true, parts: 1, to: nb });
    expect(lastSms(w, nb)).toBe("Hello Kwabena");
    sms.sendText(w, { from: nb, to: na, text: "Hi Adwoa, got it" });
    expect(sms.sendText(w, { from: na, to: nb, text: "x".repeat(161) }).parts).toBe(2);
    expect(() => sms.sendText(w, { from: na, to: nb, text: "x".repeat(481) })).toThrow(/too long/);
    expect(() => sms.sendText(w, { from: na, to: nb, text: "   " })).toThrow(/Message is required/);
    expect(() => sms.sendText(w, { from: na, to: "12345", text: "hi" })).toThrow(/not a valid mobile number/);

    // Not delivered: an unknown number and a blocked one. The sender still sees the attempt.
    expect(sms.sendText(w, { from: na, to: "0200000000", text: "anyone?" })).toMatchObject({ delivered: false, reason: "Number not in service" });
    telco.setSimStatus(w, "telecel", tel, nb, "blocked", "lost");
    expect(sms.sendText(w, { from: na, to: nb, text: "are you there" }).delivered).toBe(false);
    expect(() => sms.sendText(w, { from: nb, to: na, text: "hi" })).toThrow(/No network service/);
    telco.setSimStatus(w, "telecel", tel, nb, "active");

    // The conversation as each phone sees it.
    const mine = sms.thread(w, na, nb);
    expect(mine.canReply).toBe(true);
    expect(mine.messages.map((m) => `${m.out ? ">" : "<"}${m.failed ? "!" : ""}${m.body.slice(0, 5)}`)).toEqual([">Hello", "<Hi Ad", ">xxxxx", ">!are y"]);
    expect(sms.thread(w, nb, na).messages.map((m) => m.out)).toEqual([false, true, false]);
    const list = sms.conversations(w, na);
    expect(list[0]).toMatchObject({ with: nb, canReply: true, lastOut: true });
    // The network's own texts (here, the welcome at SIM registration) are a conversation too, but nobody can reply to a sender name.
    expect(list.find((x) => x.with === "MTNMoMo")).toMatchObject({ canReply: false, lastOut: false });

    // A business texts a customer from its software, under its registered sender name.
    telco.onboardMerchant(w, "mtn", { msisdn: shopLine, name: "Dzifa's Provisions & Co", town: "Ho", pin: "9999" });
    const shop = walletByMsisdn(w, shopLine)!;
    expect(sms.senderIdOf(shop)).toBe("DzifasProvi");
    expect(sms.sendAppSms(w, shop, { to: nb, text: "Your order is ready" })).toMatchObject({ delivered: true, senderId: "DzifasProvi" });
    expect(sms.thread(w, nb, "DzifasProvi")).toMatchObject({ canReply: false, messages: [{ body: "Your order is ready", out: false }] });
    dial(w, na, "*170#", "1", "1234", "1234");
    expect(sms.appSmsSent(w, shop)).toMatchObject([{ to: nb, text: "Your order is ready", status: "delivered" }]);

    // Each network's records cover what left it and what arrived on it.
    const mtnLog = sms.smsRecords(w, "mtn");
    expect(mtnLog.filter((r) => r.kind === "person").length).toBe(5);
    expect(mtnLog.filter((r) => r.kind === "app").length).toBe(1);
    expect(mtnLog.some((r) => r.kind === "network" && r.from === "MTNMoMo")).toBe(true);
    expect(mtnLog.find((r) => r.body === "anyone?")).toMatchObject({ status: "failed", reason: "Number not in service", toNetwork: "" });
    const telLog = sms.smsRecords(w, "telecel");
    expect(telLog.find((r) => r.body === "Hello Kwabena")).toMatchObject({ fromNetwork: "MTN", toNetwork: "Telecel", status: "delivered" });
    // The phone's own view carries the conversations and an open thread.
    const view = resolveSystem(["phone"]).view(w, new URLSearchParams({ msisdn: na, thread: nb })) as { phone: { conversations: unknown[]; thread: { messages: unknown[] } } };
    expect(view.phone.thread.messages.length).toBe(4);
    expect(view.phone.conversations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("partner APIs", () => {
  it("issues credentials per institution, answers subscriber checks, and runs pre-approvals, consent and short-code services", async () => {
    const http = await import("node:http");
    const partners = await import("../src/engine/partners");
    const signals = await import("../src/engine/signals");
    const approvals = await import("../src/engine/approvals");
    const apps = await import("../src/engine/ussdapps");
    const w = await resetWorld("team-02");
    const [a, c] = [person(w, "Serwaa", "Antwi", "1992-02-02"), person(w, "Nii", "Okai", "1980-08-08")];
    telco.generateSims(w, "mtn", 3);
    const point = telco.onboardSimAgent(w, "mtn", { card: c.ghana_card, name: "Point", kind: "service_centre", town: "Accra" }).id;
    const na = telco.registerSim(w, "mtn", point, { card: a.ghana_card, fingerprint: a.fingerprint }).sim.msisdn;
    const shopLine = telco.registerSim(w, "mtn", point, { card: c.ghana_card, fingerprint: c.fingerprint }).sim.msisdn;
    dial(w, na, "*170#", "1", "1234", "1234");
    const till = telco.onboardMerchant(w, "mtn", { msisdn: shopLine, name: "Okai Stores", town: "Accra", pin: "9999" }).till;
    pay.bankToWallet(w, { bank: "gcb", msisdn: na, amount: 50000 });

    // Credentials belong to one institution and stop working when suspended or replaced.
    const p = partners.createClient(w, "mtn", { name: "PayLink Ghana", till });
    expect(partners.authenticate(w, "mtn", p.id, p.secret)?.name).toBe("PayLink Ghana");
    expect(partners.authenticate(w, "at", p.id, p.secret)).toBeUndefined();
    expect(partners.authenticate(w, "mtn", p.id, "wrong")).toBeUndefined();
    expect(partners.clientWallet(w, p).display_name).toBe("Okai Stores");
    expect(() => partners.createClient(w, "mtn", { name: "X", till: "999999" })).toThrow(/No merchant/);
    expect(() => partners.createClient(w, "gcb", { name: "X" })).toThrow(/account at this bank is required/);
    expect(() => partners.clientWallet(w, partners.createClient(w, "mtn", { name: "Texts only" }))).toThrow(/no merchant wallet/);
    const fresh = partners.rotateSecret(w, "mtn", p.id);
    expect(partners.authenticate(w, "mtn", p.id, p.secret)).toBeUndefined();
    partners.setClientStatus(w, "mtn", p.id, "suspended");
    expect(partners.authenticate(w, "mtn", p.id, fresh)).toBeUndefined();
    partners.setClientStatus(w, "mtn", p.id, "active");
    expect(partners.authenticate(w, "mtn", p.id, fresh)).toBeDefined();

    // What a network tells a partner about its own numbers.
    expect(signals.subscriber(w, "mtn", na)).toMatchObject({ registeredName: "Serwaa Antwi", status: "active", mobileMoney: { registered: true } });
    expect(() => signals.subscriber(w, "telecel", na)).toThrow(/not a Telecel subscriber/);
    expect(signals.simSwapCheck(w, "mtn", { phoneNumber: na, maxAge: 240 })).toEqual({ swapped: false });
    telco.swapSim(w, "mtn", point, { msisdn: na, card: a.ghana_card, fingerprint: a.fingerprint });
    expect(signals.simSwapCheck(w, "mtn", { phoneNumber: na })).toEqual({ swapped: true });
    expect(signals.simSwapDate(w, "mtn", { phoneNumber: na }).latestSimChange).toBeTruthy();
    expect(signals.kycMatch(w, "mtn", { phoneNumber: na, name: "antwi  SERWAA", birthdate: "1992-02-03", idDocument: a.ghana_card.replace(/-/g, "") })).toEqual({ idDocumentMatch: "true", nameMatch: "true", birthdateMatch: "false" });
    expect(() => signals.kycMatch(w, "mtn", { phoneNumber: na })).toThrow(/at least one detail/);
    setConfig(w.db, "telco.mtn", { ...getConfig(w.db, "telco.mtn"), simSwapMomoHoldHours: 0 }, "No hold", "api");

    // A standing permission: once the customer grants it, the business charges without asking.
    const shop = partners.clientWallet(w, p);
    approvals.createApproval(w, { ref: "r1", kind: "rtp", payeeWallet: shop.id, payerMsisdn: na, amount: 1000 });
    expect(approvals.getApproval(w, "r1")!.status).toBe("PENDING");
    approvals.rejectApproval(w, "r1", "test");
    approvals.createPreapproval(w, { ref: "pre1", payeeWallet: shop.id, payerMsisdn: na, message: "Monthly plan" });
    expect(dial(w, na, "*170#", "4").text).toMatch(/Let Okai Stores take payments without asking/);
    expect(dial(w, na, "*170#", "4", "1", "1", "1234").text).toMatch(/can now take payments from your wallet without asking/);
    expect(approvals.getPreapproval(w, "pre1")!.status).toBe("SUCCESSFUL");
    const before = walletByMsisdn(w, na)!.balance;
    approvals.createApproval(w, { ref: "r2", kind: "rtp", payeeWallet: shop.id, payerMsisdn: na, amount: 1500 });
    expect(approvals.getApproval(w, "r2")!.status).toBe("SUCCESSFUL");
    expect(walletByMsisdn(w, na)!.balance).toBe(before - 1500);
    approvals.cancelPreapproval(w, "pre1", shop.id);
    approvals.createApproval(w, { ref: "r3", kind: "rtp", payeeWallet: shop.id, payerMsisdn: na, amount: 1500 });
    expect(approvals.getApproval(w, "r3")!.status).toBe("PENDING");
    approvals.rejectApproval(w, "r3", "test");

    // Consent to share a profile is the customer's to give or refuse.
    const consent = approvals.createConsent(w, { clientId: p.id, partnerName: p.name, msisdn: na, scope: "profile" });
    expect(dial(w, na, "*170#", "4", "1", "2").text).toMatch(/You have refused/);
    expect(approvals.getConsent(w, consent.ref)!.status).toBe("REJECTED");
    const again = approvals.createConsent(w, { clientId: p.id, partnerName: p.name, msisdn: na, scope: "profile" });
    expect(dial(w, na, "*170#", "4", "1", "1", "1234").text).toMatch(/shared with PayLink Ghana/);
    expect(approvals.getConsent(w, again.ref)!.status).toBe("APPROVED");

    // A provider's own USSD service: allocated by the NCA, switched on by the network, served by the provider.
    const seen: { input: string; text: string; newSession: boolean }[] = [];
    const server = http.createServer((req, res) => {
      let d = "";
      req.on("data", (x) => (d += x));
      req.on("end", () => {
        const b = JSON.parse(d);
        seen.push(b);
        res.end(b.newSession ? "CON Okai Stores\n1) My points" : JSON.stringify({ message: `You have 40 points, ${b.msisdn}`, continueSession: false }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ussd`;
    expect(() => apps.allocateCode(w, { code: "*170#", owner: "X", url })).toThrow(/already used by the networks/);
    expect(() => apps.allocateCode(w, { code: "714", owner: "X", url })).toThrow(/looks like/);
    apps.allocateCode(w, { code: "*714#", owner: "Okai Stores", url });
    expect((await apps.dial(w, { msisdn: na, input: "*714#" })).text).toMatch(/not available on MTN/);
    apps.setActivation(w, "mtn", "*714#", true);
    const first = await apps.dial(w, { msisdn: na, input: "*714#" });
    expect(first).toMatchObject({ text: "Okai Stores\n1) My points", end: false });
    expect(await apps.dial(w, { msisdn: na, input: "1", sessionId: first.sessionId })).toMatchObject({ text: `You have 40 points, ${na}`, end: true });
    expect(seen.map((x) => `${x.newSession}:${x.input}:${x.text}`)).toEqual(["true::", "false:1:1"]);
    // The network's own codes still work through the same dialler.
    expect((await apps.dial(w, { msisdn: na, input: "*170#" })).text).toMatch(/^MTN MoMo/);
    server.close();
    expect((await apps.dial(w, { msisdn: na, input: "*714#" })).text).toMatch(/not responding/);
    apps.revokeCode(w, "*714#");
    expect((await apps.dial(w, { msisdn: na, input: "*714#" })).text).toMatch(/Unknown USSD code/);
  });
});

describe("access links", () => {
  it("gives each team three different keys, and each key only its own role", async () => {
    const { registry, roleKey, roleOfKey, roleHome } = await import("../src/engine/worlds");
    const [one, two] = registry().teams;
    const keys = (["team", "customer", "agent"] as const).map((r) => roleKey(one, r));
    expect(new Set(keys).size).toBe(3);
    expect(keys.map((k) => roleOfKey(one, k))).toEqual(["team", "customer", "agent"]);
    // The same code is printed every time, and one team's phone code is no use in another team's world.
    expect(roleKey(one, "customer")).toBe(keys[1]);
    expect(roleOfKey(two, keys[1])).toBeUndefined();
    expect(roleOfKey(one, "nope")).toBeUndefined();
    expect(roleOfKey(one, undefined)).toBeUndefined();
    expect([roleHome("team-01", "team"), roleHome("team-01", "customer"), roleHome("team-01", "agent")]).toEqual(["/t/team-01", "/t/team-01/phone", "/t/team-01/agent"]);
  });

  it("keeps the consoles and the phone apart, so neither can take the other away from a device", async () => {
    const { savedRole, consoleCookie, phoneCookie } = await import("../src/server/http");
    const { registry, roleKey } = await import("../src/engine/worlds");
    const t = registry().teams[0];
    const console_ = `${consoleCookie(t.id)}=${t.key}`;
    const customer = `${phoneCookie(t.id)}=${roleKey(t, "customer")}`;
    const agent = `${phoneCookie(t.id)}=${roleKey(t, "agent")}`;
    expect(savedRole(t, null)).toBeUndefined();
    expect(savedRole(t, customer)).toBe("customer");
    expect(savedRole(t, `other=1; ${agent}`)).toBe("agent");
    // A device that has opened the team link is a console, whatever phone code it opened before or after.
    expect(savedRole(t, `${customer}; ${console_}`)).toBe("team");
    expect(savedRole(t, `${console_}; ${agent}`)).toBe("team");
    // What a browser kept before the two were separated still counts, and can no longer hide the team link.
    expect(savedRole(t, `momo_${t.id}=${t.key}`)).toBe("team");
    expect(savedRole(t, `momo_${t.id}=${roleKey(t, "customer")}`)).toBe("customer");
    expect(savedRole(t, `momo_${t.id}=${roleKey(t, "customer")}; ${console_}`)).toBe("team");
    // The same name sent twice: the widest access wins.
    expect(savedRole(t, `momo_${t.id}=${roleKey(t, "customer")}; momo_${t.id}=${t.key}`)).toBe("team");
    // A key for another team, or a wrong one, opens nothing.
    expect(savedRole(t, `${consoleCookie(t.id)}=${registry().teams[1].key}`)).toBeUndefined();
    expect(savedRole(t, `${consoleCookie(t.id)}=nonsense`)).toBeUndefined();
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

describe("plug-in points: an outside API plugged into an institution's own steps", () => {
  let w: World;
  let api: import("node:http").Server;
  let url = "";
  let amaNo = "", kofiNo = "", point = "";
  /** How the pretend outside API answers, and everything it was asked. */
  let answer: (point: string, data: Record<string, unknown>) => Record<string, unknown> = () => ({ decision: "allow" });
  const asked: { point: string; data: Record<string, unknown> }[] = [];
  let run: <T>(fn: () => T) => Promise<T>;
  let plug: (institution: string, point: string, extra?: Record<string, unknown>) => string;
  const settled = () => new Promise((r) => setTimeout(r, 60));

  beforeAll(async () => {
    const http = await import("node:http");
    const integrations = await import("../src/engine/integrations");
    api = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body) as { point: string; data: Record<string, unknown> };
        asked.push(j);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(j.point, j.data)));
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(api.address() as import("node:net").AddressInfo).port}/`;

    w = await resetWorld("team-02");
    run = (fn) => integrations.locked(w, fn);
    plug = (institution, p, extra = {}) => integrations.addIntegration(w, institution, { point: p, name: `Test ${p}`, url, ...extra }).id;
    const [ama, kofi] = [person(w, "Ama", "Serwaa", "1994-03-12"), person(w, "Kofi", "Badu", "1988-08-08")];
    telco.generateSims(w, "mtn", 3);
    point = telco.onboardSimAgent(w, "mtn", { card: ama.ghana_card, name: "Point", kind: "service_centre", town: "Tema" }).id;
    amaNo = telco.registerSim(w, "mtn", point, { card: ama.ghana_card, fingerprint: ama.fingerprint }).sim.msisdn;
    kofiNo = telco.registerSim(w, "mtn", point, { card: kofi.ghana_card, fingerprint: kofi.fingerprint }).sim.msisdn;
    return () => api.close();
  });

  it("a PIN-checking API rejects the last four digits of the number, and the customer is asked for another", async () => {
    answer = (p, d) => (p === "pin.set" && String(d.msisdn).endsWith(String(d.pin)) ? { decision: "reject", message: "Too easy to guess: it is the end of your number." } : { decision: "allow" });
    plug("mtn", "pin.set");
    const weak = amaNo.slice(-4);
    const strong = weak === "2580" ? "1379" : "2580";

    let s = await run(() => ussd(w, { msisdn: amaNo, input: "*170#" }));
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: "1" }));
    expect(s.text).toMatch(/Create a 4-digit PIN/);
    // The weak PIN is refused with the API's own words, and the session stays open for another try.
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: weak }));
    expect(s).toMatchObject({ end: false });
    expect(s.text).toMatch(/Too easy to guess/);
    expect(walletByMsisdn(w, amaNo)).toBeUndefined();
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: strong }));
    expect(s.text).toMatch(/again to confirm/);
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: strong }));
    expect(s.text).toMatch(/You are now registered/);
    expect(walletByMsisdn(w, amaNo)?.pin).toBe(strong);

    // The API was told who was choosing, and the network kept a record of each question and answer.
    expect(asked[0]).toMatchObject({ point: "pin.set", data: { msisdn: amaNo, pin: weak, reason: "new_wallet", customer: { name: "Ama Serwaa", dateOfBirth: "1994-03-12" } } });
    const log = view<{ pluginCalls: { decision: string; message: string | null }[] }>(w, "telco", "mtn").pluginCalls;
    expect(log.map((c) => c.decision)).toContain("reject");

    // It also guards a PIN change, and an agent opening a wallet for someone.
    await expect(run(() => telco.changePin(w, walletByMsisdn(w, amaNo)!, weak))).rejects.toThrow(/Too easy to guess/);
    expect(walletByMsisdn(w, amaNo)?.pin).toBe(strong);
    // Other networks are not affected: nothing is plugged into them.
    const before = asked.length;
    await run(() => telco.generateSims(w, "telecel", 1));
    expect(asked.length).toBe(before);
  });

  it("at the moment of payment the API can warn, pause or block, and a half-done payment leaves no trace", async () => {
    const strong = walletByMsisdn(w, amaNo)!.pin;
    await run(() => telco.selfRegisterWallet(w, kofiNo, "8642"));
    w.db.prepare("UPDATE wallets SET balance = 50000 WHERE msisdn = ?").run(amaNo);
    w.db.prepare("INSERT INTO postings(txn_id, account, amount, at) VALUES('seed', ?, 50000, 0)").run(`w:w_${amaNo}`);
    const send = async (amount: string, ...more: string[]) => {
      let s = await run(() => ussd(w, { msisdn: amaNo, input: "*170#" }));
      for (const input of ["1", "1", kofiNo, kofiNo, amount, "test", strong, ...more]) {
        if (s.end) break;
        s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input }));
      }
      return s;
    };
    const txns = () => count(w.db, "SELECT COUNT(*) AS n FROM txns");
    const balance = () => walletByMsisdn(w, amaNo)!.balance;

    plug("mtn", "payment.authorize");
    plug("mtn", "events");

    // Warn: nothing moves until the customer has read the warning and chosen to continue.
    answer = (p) => (p === "payment.authorize" ? { decision: "warn", message: "You have never paid this number before." } : {});
    const [n0, b0] = [txns(), balance()];
    let s = await send("20");
    expect(s).toMatchObject({ end: false });
    expect(s.text).toMatch(/never paid this number before[\s\S]*1\) Continue/);
    expect([txns(), balance()]).toEqual([n0, b0]);
    const question = asked.findLast((a) => a.point === "payment.authorize")!;
    expect(question.data).toMatchObject({ type: "p2p", amount: 20, payer: { msisdn: amaNo, balance: 500, onCallWith: null }, payee: { msisdn: kofiNo }, paymentsToThisPayeeBefore: 0, afterDelay: false });
    // Cancel: still nothing moved.
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: "2" }));
    expect(s.text).toMatch(/cancelled/i);
    expect(balance()).toBe(b0);
    // Continue: the money moves.
    s = await send("20", "1");
    expect(s.text).toMatch(/sent to Kofi Badu/);
    expect(balance()).toBeLessThan(b0);
    await settled();
    expect(asked.filter((a) => a.point === "events").map((a) => a.data.event)).toEqual(expect.arrayContaining(["payment.warning_shown", "payment.cancelled_after_warning", "payment.completed"]));
    expect(asked.findLast((a) => a.data.event === "payment.completed")!.data).toMatchObject({ continuedAfterWarning: true, amount: 20 });

    // Block: refused with the API's message, and the refusal is on the network's records.
    answer = (p) => (p === "payment.authorize" ? { decision: "reject", message: "This number has been reported for fraud." } : {});
    const b1 = balance();
    s = await send("30");
    expect(s.text).toMatch(/reported for fraud/);
    expect(balance()).toBe(b1);
    expect((w.db.prepare("SELECT status, reason FROM txns ORDER BY rowid DESC LIMIT 1").get() as { status: string; reason: string })).toMatchObject({ status: "failed", reason: "This number has been reported for fraud." });

    // Pause: refused now, and again without asking while the pause lasts.
    answer = (p) => (p === "payment.authorize" ? { decision: "delay", minutes: 5, message: "Paused for 5 minutes. Hang up and think it over." } : {});
    s = await send("30");
    expect(s.text).toMatch(/Hang up and think it over/);
    const questions = asked.filter((a) => a.point === "payment.authorize").length;
    s = await send("30");
    expect(s.text).toMatch(/paused for your protection until/);
    expect(asked.filter((a) => a.point === "payment.authorize").length).toBe(questions);
    expect(balance()).toBe(b1);

    // The books still balance after all of that.
    expect(count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings WHERE txn_id != 'seed'")).toBe(0);
  });

  it("an API that is down is treated as its owner chose: carry on, or refuse", async () => {
    const integrations = await import("../src/engine/integrations");
    w.cooldowns.clear();
    for (const p of integrations.listIntegrations(w, "mtn")) integrations.removeIntegration(w, "mtn", p.id);
    const dead = "http://127.0.0.1:9/";
    const id = integrations.addIntegration(w, "mtn", { point: "payment.authorize", name: "Down", url: dead }).id;
    const from = walletByMsisdn(w, amaNo)!, to = walletByMsisdn(w, kofiNo)!;
    const b0 = from.balance;
    await run(() => pay.walletPay(w, { type: "p2p", channel: "api", from: from.id, to: to.id, amount: 1000 }));
    expect(walletByMsisdn(w, amaNo)!.balance).toBeLessThan(b0);
    integrations.removeIntegration(w, "mtn", id);
    integrations.addIntegration(w, "mtn", { point: "payment.authorize", name: "Down, strict", url: dead, failOpen: false });
    await expect(run(() => pay.walletPay(w, { type: "p2p", channel: "api", from: from.id, to: to.id, amount: 1000 }))).rejects.toThrow(/temporarily unavailable/);
    expect(integrations.integrationLog(w, "mtn")[0]).toMatchObject({ decision: "error" });
    expect(() => integrations.addIntegration(w, "mtn", { point: "transfer.authorize", name: "x", url })).toThrow(/no such step/);
    expect(() => integrations.addIntegration(w, "mtn", { point: "pin.set", name: "x", url: "http://169.254.169.254/latest" })).toThrow(/not allowed/);
    for (const p of integrations.listIntegrations(w, "mtn")) integrations.removeIntegration(w, "mtn", p.id);
  });

  it("SIM swaps, texts, calls and bank transfers can be screened too", async () => {
    const sms = await import("../src/engine/sms");
    const calls = await import("../src/engine/calls");
    const ama = w.db.prepare("SELECT p.* FROM persons p JOIN sims s ON s.person_id = p.id WHERE s.msisdn = ?").get(amaNo) as unknown as Person;
    for (const p of ["sim.swap", "sms.deliver", "call.connect"]) plug("mtn", p);
    answer = (p, d) =>
      p === "sim.swap" ? { decision: "reject", message: "Too many replacements requested at this point today." }
      : p === "sms.deliver" ? (/by mistake/.test(String(d.text)) ? { decision: "warn", message: "Possible scam" } : /win/.test(String(d.text)) ? { decision: "reject" } : { decision: "allow" })
      : p === "call.connect" ? { decision: "warn", message: "Reported 12 times as a scam caller" }
      : { decision: "allow" };

    await expect(run(() => telco.swapSim(w, "mtn", point, { msisdn: amaNo, card: ama.ghana_card, fingerprint: ama.fingerprint }))).rejects.toThrow(/Too many replacements/);
    expect(asked.findLast((a) => a.point === "sim.swap")!.data).toMatchObject({ msisdn: amaNo, hasWallet: true, swapsOnThisNumberBefore: 0 });
    expect(telco.getSim(w, amaNo)!.last_swap_at).toBeNull();

    // A text with a warning arrives labelled; a blocked one never arrives.
    expect(await run(() => sms.sendText(w, { from: kofiNo, to: amaNo, text: "I sent you GHS 500 by mistake" }))).toMatchObject({ delivered: true });
    expect(sms.thread(w, amaNo, kofiNo).messages.at(-1)).toMatchObject({ out: false, warning: "Possible scam" });
    expect(sms.thread(w, kofiNo, amaNo).messages.at(-1)).toMatchObject({ out: true, warning: null });
    expect(await run(() => sms.sendText(w, { from: kofiNo, to: amaNo, text: "You win a prize" }))).toMatchObject({ delivered: false });
    expect(sms.thread(w, amaNo, kofiNo).messages.at(-1)!.body).toMatch(/by mistake/);

    // An incoming call shows the label on the screen of the person being called.
    calls.pollCall(w, { msisdn: amaNo, device: "A" });
    const { id } = await run(() => calls.startCall(w, { from: kofiNo, to: amaNo, device: "K", offer: "o" }));
    expect(calls.pollCall(w, { msisdn: amaNo, device: "A" }).call).toMatchObject({ id, role: "callee", warning: "Reported 12 times as a scam caller" });
    expect(calls.pollCall(w, { msisdn: kofiNo, device: "K", callId: id }).call?.warning).toBeUndefined();
    calls.endCall(w, { callId: id, msisdn: kofiNo });

    // A bank asks before money leaves an account.
    plug("gcb", "transfer.authorize");
    answer = (p) => (p === "transfer.authorize" ? { decision: "reject", message: "Unusual transfer for this account." } : { decision: "allow" });
    const account = openAccount(w, "gcb", { card: ama.ghana_card, fingerprint: ama.fingerprint });
    pay.bankCash(w, { bank: "gcb", account: account.id, amount: 100000, kind: "deposit" });
    await expect(run(() => pay.bankToWallet(w, { bank: "gcb", fromAccount: account.id, msisdn: kofiNo, amount: 5000 }))).rejects.toThrow(/Unusual transfer/);
    // Cash over the counter is not a transfer from an account, so it is not screened.
    await run(() => pay.bankToWallet(w, { bank: "gcb", msisdn: kofiNo, amount: 5000 }));
  });

  it("the menu, money arriving, payment requests, KYC, PIN resets, sign-ups, bank accounts and the switch can be screened too", async () => {
    const integrations = await import("../src/engine/integrations");
    const approvals = await import("../src/engine/approvals");
    for (const i of ["mtn", "gcb"]) for (const p of integrations.listIntegrations(w, i)) integrations.removeIntegration(w, i, p.id);
    w.cooldowns.clear();
    const only = (point: string, reply: Record<string, unknown>) => {
      answer = (p) => (p === point ? reply : { decision: "allow" });
    };
    const ama = w.db.prepare("SELECT p.* FROM persons p JOIN sims s ON s.person_id = p.id WHERE s.msisdn = ?").get(amaNo) as unknown as Person;
    const last = (point: string) => asked.findLast((a) => a.point === point)!.data;

    // Before the menu opens: a message the customer must read first, or no menu at all.
    plug("mtn", "menu.open");
    only("menu.open", { decision: "warn", message: "A message before the menu." });
    let s = await run(() => ussd(w, { msisdn: amaNo, input: "*170#" }));
    expect(s).toMatchObject({ end: false });
    expect(s.text).toMatch(/A message before the menu\.\n1\) Continue/);
    expect(last("menu.open")).toMatchObject({ msisdn: amaNo, hasWallet: true, onCallWith: null });
    s = await run(() => ussd(w, { sessionId: s.sessionId, msisdn: amaNo, input: "1" }));
    expect(s.text).toContain((getConfig(w.db, "telco.mtn").menu.nodes.main as { text: string }).text);
    only("menu.open", { decision: "reject", message: "Not available." });
    expect(await run(() => ussd(w, { msisdn: amaNo, input: "*170#" }))).toMatchObject({ end: true, text: "Not available." });
    only("", {});

    // Money arriving: the payee's network is asked, and can refuse it.
    plug("mtn", "payment.receive");
    only("payment.receive", { decision: "reject", message: "This wallet cannot receive money right now." });
    const from = walletByMsisdn(w, amaNo)!, to = walletByMsisdn(w, kofiNo)!;
    await expect(run(() => pay.walletPay(w, { type: "p2p", channel: "api", from: from.id, to: to.id, amount: 500 }))).rejects.toThrow(/cannot receive money/);
    expect(last("payment.receive")).toMatchObject({ amount: 5, payer: { msisdn: amaNo }, payee: { msisdn: kofiNo, paymentsReceivedInLast24Hours: expect.any(Number) } });
    expect(walletByMsisdn(w, amaNo)!.balance).toBe(from.balance);

    // Signing up a merchant.
    const esi = person(w, "Esi", "Quaye", "1983-03-03");
    const shopNo = telco.registerSim(w, "mtn", point, { card: esi.ghana_card, fingerprint: esi.fingerprint }).sim.msisdn;
    plug("mtn", "business.onboard");
    only("business.onboard", { decision: "reject", message: "Sign-up refused." });
    await expect(run(() => telco.onboardMerchant(w, "mtn", { msisdn: shopNo, name: "Esi Provisions", town: "Tema", pin: "1357" }))).rejects.toThrow(/Sign-up refused/);
    expect(last("business.onboard")).toMatchObject({ type: "merchant", businessName: "Esi Provisions", owner: { name: "Esi Quaye" } });
    only("", {});
    await run(() => telco.onboardMerchant(w, "mtn", { msisdn: shopNo, name: "Esi Provisions", town: "Tema", pin: "1357" }));

    // A business asks a customer to pay: blocked before the customer ever sees it.
    plug("mtn", "payment.request");
    only("payment.request", { decision: "reject", message: "Request blocked." });
    const r = await run(() => approvals.createApproval(w, { kind: "rtp", payeeWallet: `w_${shopNo}`, payerMsisdn: amaNo, amount: 1000, payerMessage: "Order 1" }));
    expect(r).toMatchObject({ status: "FAILED", reason: "Request blocked." });
    expect(approvals.pendingFor(w, amaNo)).toHaveLength(0);
    expect(last("payment.request")).toMatchObject({ kind: "payment_request", amount: 10, requester: { name: "Esi Provisions" }, customer: { msisdn: amaNo }, customerHasPaidThisRequesterBefore: false });

    // KYC upgrades and PIN resets.
    plug("mtn", "kyc.upgrade");
    plug("mtn", "pin.reset");
    only("kyc.upgrade", { decision: "reject", message: "Upgrade refused." });
    await expect(run(() => telco.upgradeTier(w, "mtn", amaNo, "medium", "back office"))).rejects.toThrow(/Upgrade refused/);
    only("pin.reset", { decision: "reject", message: "Reset refused." });
    await expect(run(() => telco.resetPin(w, "mtn", point, { msisdn: amaNo, card: ama.ghana_card, fingerprint: ama.fingerprint }))).rejects.toThrow(/Reset refused/);
    expect(walletByMsisdn(w, amaNo)).toMatchObject({ kyc_tier: "minimum", pin: from.pin });

    // Opening a bank account.
    plug("ecobank", "account.open");
    only("account.open", { decision: "reject", message: "Account refused." });
    await expect(run(() => openAccount(w, "ecobank", { card: ama.ghana_card, fingerprint: ama.fingerprint }))).rejects.toThrow(/Account refused/);
    expect(last("account.open")).toMatchObject({ bank: "ecobank", accountsAtOtherBanks: 1 });

    // The national switch, between a network and a bank.
    for (const p of integrations.listIntegrations(w, "mtn")) integrations.removeIntegration(w, "mtn", p.id);
    plug("switch", "switch.route");
    plug("switch", "events");
    const acct = w.db.prepare("SELECT account_no FROM bank_accounts WHERE bank = 'gcb' AND kind = 'personal'").get() as { account_no: string };
    only("switch.route", { decision: "reject", message: "Refused by the switch." });
    await expect(run(() => pay.walletToBank(w, { from: from.id, accountNo: acct.account_no, amount: 1000, channel: "api" }))).rejects.toThrow(/Refused by the switch/);
    expect(last("switch.route")).toMatchObject({ from: "mtn", to: "gcb", amount: 10, destination: acct.account_no });
    expect(count(w.db, "SELECT COUNT(*) AS n FROM switch_log WHERE step = 'reject' AND detail = 'Refused by the switch.'")).toBe(1);
    only("", {});
    await run(() => pay.walletToBank(w, { from: from.id, accountNo: acct.account_no, amount: 1000, channel: "api" }));
    await settled();
    expect(asked.findLast((a) => a.data.event === "payment.routed")!.data).toMatchObject({ from: "mtn", to: "gcb", amount: 10 });

    // Something that happens on a refused request is still reported: a wallet locking on wrong PINs.
    plug("mtn", "events");
    const attempts = getConfig(w.db, "telco.mtn").pinAttemptsBeforeLock;
    for (let i = 0; i < attempts; i++) await expect(run(() => pay.walletPay(w, { type: "p2p", channel: "api", from: to.id, to: from.id, amount: 100, pin: "0000" }))).rejects.toThrow(/Wrong PIN/);
    await settled();
    expect(asked.findLast((a) => a.data.event === "wallet.locked")!.data).toMatchObject({ msisdn: kofiNo });
    expect(walletByMsisdn(w, kofiNo)!.status).toBe("locked");

    // Each institution only has its own steps.
    expect(integrations.pointsFor("switch").map(([id]) => id)).toEqual(["switch.route", "events"]);
    expect(() => integrations.addIntegration(w, "gcb", { point: "sim.swap", name: "x", url })).toThrow(/no such step/);
  });
});

describe("simulated data: a ready-made country with labelled fraud", () => {
  const rows = <T>(w: World, sql: string, ...args: (string | number)[]) => w.db.prepare(sql).all(...args) as T[];
  const one = <T>(w: World, sql: string, ...args: (string | number)[]) => w.db.prepare(sql).get(...args) as T;

  it("builds people, lines, wallets and a history with the exact share of fraud, and the books balance", async () => {
    const { simulate, SCENARIOS } = await import("../src/engine/simulate");
    const w = await resetWorld("team-02");
    const s = simulate(w, { total: 8000, seed: 7 });

    // Exactly the number asked for, and exactly 22% of it fraud, spread over all ten kinds.
    expect(s).toMatchObject({ transactions: 8000, fraud: 1760, legitimate: 6240 });
    expect(count(w.db, "SELECT COUNT(*) AS n FROM dataset")).toBe(8000);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM dataset WHERE is_fraud = 1")).toBe(1760);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM dataset d JOIN txns t ON t.id = d.txn_id")).toBe(8000);
    const kinds = rows<{ scenario: string; n: number }>(w, "SELECT scenario, COUNT(*) AS n FROM dataset WHERE is_fraud = 1 GROUP BY scenario");
    expect(kinds.map((k) => k.scenario).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(kinds.every((k) => k.n > 30)).toBe(true);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM dataset WHERE is_fraud = 0 AND scenario IS NOT NULL")).toBe(0);

    // Everyone has a Ghana Card, every line was registered against one at a registration point, every wallet sits on a line.
    expect(count(w.db, "SELECT COUNT(*) AS n FROM persons WHERE ghana_card NOT GLOB 'GHA-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]'")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM sims s WHERE s.status = 'active' AND (NOT EXISTS (SELECT 1 FROM persons p WHERE p.id = s.person_id) OR NOT EXISTS (SELECT 1 FROM sim_agents a WHERE a.id = s.registered_by))")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM wallets x WHERE NOT EXISTS (SELECT 1 FROM sims s WHERE s.msisdn = x.msisdn AND s.status = 'active')")).toBe(0);
    expect(count(w.db, "SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM sims WHERE status = 'active' GROUP BY person_id)")).toBeLessThanOrEqual(10);

    // The ledger: every transaction balances, no wallet or account is overdrawn, and balances are what the postings say.
    expect(count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM (SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount) != 0)")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM wallets WHERE balance < 0")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM bank_accounts WHERE kind = 'personal' AND balance < 0")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM wallets x WHERE balance != (SELECT COALESCE(SUM(amount),0) FROM postings WHERE account = 'w:' || x.id)")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM bank_accounts a WHERE balance != (SELECT COALESCE(SUM(amount),0) FROM postings WHERE account = 'bank:' || a.id)")).toBe(0);
    const bog = view<{ issuers: { backed: boolean }[]; ledgerBalanced: boolean }>(w, "bog");
    expect(JSON.stringify(bog)).not.toContain('"backed":false');
    expect(bog.ledgerBalanced).toBe(true);
    // Refused transactions moved no money.
    expect(count(w.db, "SELECT COUNT(*) AS n FROM txns t WHERE t.status = 'failed' AND EXISTS (SELECT 1 FROM postings p WHERE p.txn_id = t.id)")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM txns WHERE status = 'failed'")).toBeGreaterThan(50);

    // The scenarios leave the traces a real case would.
    // SIM swap: the wallet is emptied only after the pause that follows the replacement; attempts before that were refused.
    const drains = rows<{ at: number; swapped: number; status: string }>(
      w,
      `SELECT t.created_at AS at, t.status, (SELECT MAX(e.at) FROM sim_events e WHERE e.msisdn = x.msisdn AND e.kind = 'swapped' AND e.at <= t.created_at) AS swapped
       FROM dataset d JOIN txns t ON t.id = d.txn_id JOIN wallets x ON x.id = t.from_wallet WHERE d.scenario = 'sim_swap' AND d.role IN ('unauthorised_transfer','unauthorised_cash_out','failed_attempt')`,
    );
    expect(drains.length).toBeGreaterThan(20);
    for (const d of drains) expect(d.status === "success" ? d.at - d.swapped >= 24 * 3600_000 : d.at - d.swapped < 24 * 3600_000).toBe(true);
    // Reversal scam: the victim pays while the fraudster is on the line, after a fake "payment received" text.
    const reversal = rows<{ id: string; at: number; payer: string; payee: string }>(w, "SELECT t.id, t.created_at AS at, f.msisdn AS payer, p.msisdn AS payee FROM dataset d JOIN txns t ON t.id = d.txn_id JOIN wallets f ON f.id = t.from_wallet JOIN wallets p ON p.id = t.to_wallet WHERE d.scenario = 'reversal_scam' AND d.role = 'victim_payment'");
    for (const r of reversal.slice(0, 40)) {
      expect(count(w.db, "SELECT COUNT(*) AS n FROM calls WHERE from_msisdn = ? AND to_msisdn = ? AND answered_at <= ? AND ended_at >= ?", r.payee, r.payer, r.at, r.at)).toBeGreaterThanOrEqual(1);
      expect(count(w.db, "SELECT COUNT(*) AS n FROM sms_log WHERE sender = ? AND to_msisdn = ? AND at < ? AND body LIKE 'Payment received%'", r.payee, r.payer, r.at)).toBeGreaterThanOrEqual(1);
    }
    // Limit splitting: the pieces are each under the small wallets' daily limit.
    expect(one<{ n: number }>(w, "SELECT MAX(t.amount) AS n FROM dataset d JOIN txns t ON t.id = d.txn_id WHERE d.role = 'splitting' AND t.status = 'success'").n).toBeLessThanOrEqual(300000);
    // A case is the victim's loss followed by the money moving on, in order.
    const chain = rows<{ role: string }>(w, "SELECT d.role FROM dataset d WHERE d.case_id = (SELECT case_id FROM dataset WHERE role = 'cashing_out' AND scenario = 'relative_impersonation' LIMIT 1) ORDER BY d.seq");
    expect(chain[0].role).toBe("victim_payment");
    expect(chain.at(-1)!.role).toBe("cashing_out");
    // Many lines used to move the money sit on a few Ghana Cards.
    expect(one<{ n: number }>(w, "SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM sims GROUP BY person_id)").n).toBeGreaterThanOrEqual(5);

    // It cannot be loaded on top of something else.
    expect(() => simulate(w, { total: 8000 })).toThrow(/empty world/);
  });

  it("gives the same country for the same seed, and a different one for another", async () => {
    const { simulate } = await import("../src/engine/simulate");
    const end = Date.UTC(2026, 10, 1);
    const sample = async (seed: number) => {
      const w = await resetWorld("team-02");
      simulate(w, { total: 3000, seed, end });
      return JSON.stringify(rows(w, "SELECT t.id, t.type, t.amount, t.created_at, t.from_wallet, t.to_wallet, d.scenario FROM dataset d JOIN txns t ON t.id = d.txn_id ORDER BY d.seq LIMIT 400"));
    };
    const a = await sample(11);
    expect(await sample(11)).toBe(a);
    expect(await sample(12)).not.toBe(a);
  });

  it("can be downloaded, with or without the answers, and the live sandbox carries on from it", async () => {
    const { simulate } = await import("../src/engine/simulate");
    const { datasetCsv, DATASET_FILES } = await import("../src/engine/dataset");
    const w = await resetWorld("team-02");
    simulate(w, { total: 3000, seed: 3 });

    const csv = [...datasetCsv(w, "transactions")].join("").trimEnd().split("\n");
    expect(csv).toHaveLength(3001);
    expect(csv[0]).toMatch(/^number,transaction_id,time,type,.*,is_fraud,fraud_scenario,fraud_role,fraud_case$/);
    expect(csv.filter((l) => /,1,[a-z_]+,[a-z_]+,case_\d+$/.test(l))).toHaveLength(660);
    const blind = [...datasetCsv(w, "transactions", false)].join("").trimEnd().split("\n");
    expect(blind).toHaveLength(3001);
    expect(blind[0]).not.toMatch(/fraud/);
    expect(blind.join("\n")).not.toMatch(/case_\d+/);
    for (const name of Object.keys(DATASET_FILES)) expect([...datasetCsv(w, name)].join("").split("\n").length).toBeGreaterThan(10);
    // No PINs or fingerprints leave in the files.
    expect([...datasetCsv(w, "wallets")].join("")).not.toMatch(/pin/i);
    expect([...datasetCsv(w, "people")].join("")).not.toMatch(/FP-/);

    // A simulated customer can use their phone and pay as anyone else does.
    const a = one<{ id: string; msisdn: string; pin: string; balance: number }>(w, "SELECT id, msisdn, pin, balance FROM wallets WHERE owner_type = 'person' AND telco = 'mtn' AND kyc_tier = 'medium' AND balance > 5000 ORDER BY id LIMIT 1");
    const b = one<{ id: string; msisdn: string; balance: number }>(w, "SELECT id, msisdn, balance FROM wallets WHERE owner_type = 'person' AND telco = 'mtn' AND kyc_tier = 'medium' AND id != ? ORDER BY id LIMIT 1", a.id);
    expect(dial(w, a.msisdn, "*170#").text).toContain((getConfig(w.db, "telco.mtn").menu.nodes.main as { text: string }).text);
    pay.walletPay(w, { type: "p2p", channel: "ussd", from: a.id, to: b.id, amount: 1000, pin: a.pin });
    expect(walletByMsisdn(w, b.msisdn)!.balance).toBe(b.balance + 1000);
    // And new people can still be registered from the blank SIMs in stock.
    const p = person(w, "Nana", "Addae", "1999-09-09");
    const point = one<{ id: string }>(w, "SELECT id FROM sim_agents WHERE telco = 'mtn' AND kind = 'service_centre' LIMIT 1").id;
    expect(telco.registerSim(w, "mtn", point, { card: p.ghana_card, fingerprint: p.fingerprint }).sim.status).toBe("active");
    // Consoles list the newest first, so the new person is at the top.
    expect(view<{ sims: { owner: string }[] }>(w, "telco", "mtn").sims[0].owner).toBe("Nana Addae");
    expect(view<{ sims: unknown[] }>(w, "telco", "mtn").sims.length).toBeLessThanOrEqual(200);
  });

  it("loads into a team's world at full size: 100,023 transactions, 22,005 of them fraud", async () => {
    const worlds = await import("../src/engine/worlds");
    const before = await resetWorld("team-01");
    person(before, "Left", "Behind");
    // What the team set up for itself survives the load: a plugged-in API, a connected application, a setting.
    const { addIntegration, listIntegrations } = await import("../src/engine/integrations");
    const { connectApp, listApps } = await import("../src/engine/fraudsim");
    addIntegration(before, "mtn", { point: "pin.set", name: "Kept", url: "http://127.0.0.1:9/" });
    connectApp(before, { name: "Kept app", url: "http://127.0.0.1:9/", kinds: "sim_swap" });
    setConfig(before.db, "telco.mtn", { ...getConfig(before.db, "telco.mtn"), simSwapMomoHoldHours: 12 }, "test", "test");
    const w = await worlds.loadSimulated("team-01");
    expect(listIntegrations(w, "mtn").map((i) => i.name)).toEqual(["Kept"]);
    expect(listApps(w)).toMatchObject([{ name: "Kept app", kinds: ["sim_swap"] }]);
    expect(getConfig(w.db, "telco.mtn").simSwapMomoHoldHours).toBe(12);
    const s = worlds.simulatedSummary(w)!;
    expect(s).toMatchObject({ transactions: 100023, fraud: 22005, legitimate: 78018 });
    expect(Object.values(s.byScenario).reduce((n, x) => n + x.transactions, 0)).toBe(22005);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM dataset")).toBe(100023);
    expect(count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM persons WHERE surname = 'Behind'")).toBe(0);
    // What the team had before is kept as a save point.
    expect(worlds.listSnapshots("team-01")[0].label).toBe("Before loading simulated data");
    // A second world gets the very same country.
    const again = await worlds.loadSimulated("team-02");
    const first = (x: World) => JSON.stringify(x.db.prepare("SELECT txn_id, is_fraud, scenario FROM dataset ORDER BY seq LIMIT 200").all());
    expect(first(again)).toBe(first(w));
    expect(totals(again).kept).toEqual(totals(again).counted);
    await resetWorld("team-01");
    await resetWorld("team-02");
  }, 180_000);
});

describe("fraud simulator: incidents played live against what a team has built", () => {
  let w: World;
  let api: import("node:http").Server;
  let url = "";
  // What an institution sends differs from step to step; the test APIs below pick out the fields they need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Sent = Record<string, any>;
  let answer: (point: string, data: Sent) => Record<string, unknown> = () => ({ decision: "allow" });
  const asked: { point: string; institution: string; data: Sent; raw: string }[] = [];
  let sim: typeof import("../src/engine/fraudsim");
  let integrations: typeof import("../src/engine/integrations");
  type Results = ReturnType<typeof import("../src/engine/fraudsim").fraudResults>;
  /** Runs the simulator and waits for it to finish. */
  const run = async (req: Record<string, unknown>): Promise<NonNullable<Results["latest"]>> => {
    sim.startRun(w, { seed: 9, ...req });
    while (sim.isRunning(w)) await new Promise((r) => setTimeout(r, 20));
    return sim.fraudResults(w).latest!;
  };
  const unplug = () => {
    for (const i of ["mtn", "telecel", "at", "gcb", "switch"]) for (const p of integrations.listIntegrations(w, i)) integrations.removeIntegration(w, i, p.id);
  };
  const everywhere = (point: string, name: string) => {
    for (const t of ["mtn", "telecel", "at"]) integrations.addIntegration(w, t, { point, name, url });
  };

  beforeAll(async () => {
    const http = await import("node:http");
    sim = await import("../src/engine/fraudsim");
    integrations = await import("../src/engine/integrations");
    const { simulate } = await import("../src/engine/simulate");
    api = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body);
        asked.push({ ...j, raw: body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(j.point, j.data)));
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(api.address() as import("node:net").AddressInfo).port}/`;
    w = await resetWorld("team-02");
    simulate(w, { total: 9000, seed: 21 });
    return () => api.close();
  }, 60_000);

  it("needs people to act as victims, and says so", async () => {
    const empty = await resetWorld("team-01");
    expect(() => sim.startRun(empty, {})).toThrow(/Load the simulated country/);
    expect(() => sim.startRun(w, { kinds: "nonsense" })).toThrow(/Unknown kind of fraud/);
  });

  it("with nothing plugged in, every kind of fraud gets through and honest activity is untouched", async () => {
    const r = await run({ kinds: "all", incidents: 22, ordinary: 24 });
    expect(r.status).toBe("finished");
    expect(r.fraud).toMatchObject({ total: 22, stopped: 0, contained: 0, through: 22 });
    expect(r.ordinary).toMatchObject({ total: 24, fine: 24, blocked: 0, slowed: 0 });
    expect(r.byKind.map((k) => k.kind).sort()).toEqual(Object.keys(sim.FRAUD_KINDS).sort());
    expect(r.lost).toBeGreaterThan(0);
    expect(r.stops).toEqual([]);
    // Each incident has its steps on record, and really happened in the world.
    const one = r.incidents.find((i) => i.scenario === "reversal_scam")!;
    expect(one.trail.map((t) => t.what)).toEqual(expect.arrayContaining(["The fraudster texts the victim", "The fraudster calls the victim", "The victim sends the money"]));
    expect(count(w.db, "SELECT COUNT(*) AS n FROM sms_log WHERE to_msisdn = ? AND body LIKE 'Payment received%' AND at > ?", one.who!, Date.now() - 600_000)).toBe(1);
    expect(count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM wallets WHERE balance < 0")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM calls WHERE status IN ('ringing','active')")).toBe(0);
  });

  it("an API plugged in at the payment step stops the scams it recognises, at that step, and is given the credit", async () => {
    // Blocks a payment made to a wallet opened in the last day while the payer is on the phone with its owner.
    everywhere("payment.authorize", "Call guard");
    answer = (p, d) => (p === "payment.authorize" && d.payer.onCallWith === d.payee.msisdn && Date.now() - Date.parse(d.payee.walletOpenedAt) < 86_400_000 ? { decision: "reject", message: "You are on a call with the person you are paying." } : { decision: "allow" });
    asked.length = 0;
    const r = await run({ kinds: "reversal_scam", incidents: 8, ordinary: 12 });
    expect(r.fraud).toMatchObject({ total: 8, stopped: 8, through: 0 });
    expect(r.lost).toBe(0);
    expect(r.ordinary.blocked).toBe(0);
    expect(r.stops).toEqual([{ step: "payment.authorize", by: "Call guard", answer: "reject", fraud: 8, ordinary: 0 }]);
    expect(r.incidents.find((i) => i.kind === "fraud")).toMatchObject({ outcome: "stopped", stoppedAt: "payment.authorize", stoppedBy: "Call guard", lost: 0, summary: "The payment was blocked" });
    // The service is asked as it would be for anything else: nothing it receives says what was fraud.
    expect(asked.length).toBeGreaterThan(8);
    expect(asked.some((a) => /fraud|scenario|simulat|incident/i.test(a.raw))).toBe(false);
    // It does nothing for a kind of fraud it was not built for.
    const other = await run({ kinds: "sim_swap", incidents: 4, ordinary: 0 });
    expect(other.fraud).toMatchObject({ total: 4, stopped: 0 });
    unplug();
  });

  it("warnings work on victims some of the time, and not on fraudsters; blocking everything shows up as honest customers stopped", async () => {
    everywhere("payment.authorize", "Warner");
    answer = (p) => (p === "payment.authorize" ? { decision: "warn", message: "Check who you are paying." } : { decision: "allow" });
    const r = await run({ kinds: ["relative_impersonation", "pin_phishing"], incidents: 30, ordinary: 20 });
    const by = Object.fromEntries(r.byKind.map((k) => [k.kind, k]));
    // Some victims cancel after the warning, some carry on.
    expect(by.relative_impersonation.stopped).toBeGreaterThan(3);
    expect(by.relative_impersonation.through).toBeGreaterThan(0);
    // When the fraudster holds the phone, a warning changes nothing.
    expect(by.pin_phishing).toMatchObject({ stopped: 0, contained: 0, through: 15 });
    expect(r.ordinary.slowed).toBeGreaterThan(0);
    unplug();

    everywhere("payment.authorize", "Wall");
    answer = () => ({ decision: "reject", message: "No." });
    const wall = await run({ kinds: "fake_promo", incidents: 6, ordinary: 30 });
    expect(wall.fraud).toMatchObject({ total: 6, stopped: 6 });
    expect(wall.ordinary.blocked).toBeGreaterThan(5);
    expect(wall.stops[0]).toMatchObject({ by: "Wall", fraud: 6 });
    expect(wall.stops[0].ordinary).toBeGreaterThan(5);
    unplug();
  });

  it("covers the other steps: texts, SIM replacement, PIN choice, the cash-out", async () => {
    // A filter on texts stops the scams that arrive only by text.
    everywhere("sms.deliver", "Text filter");
    answer = (p, d) => (p === "sms.deliver" && /CONGRATULATIONS|it's me, my phone fell/.test(d.text) ? { decision: "reject" } : { decision: "allow" });
    let r = await run({ kinds: ["fake_promo", "relative_impersonation"], incidents: 8, ordinary: 10 });
    expect(r.fraud).toMatchObject({ stopped: 8, through: 0 });
    expect(r.stops[0]).toMatchObject({ step: "sms.deliver", by: "Text filter", fraud: 8, ordinary: 0 });
    unplug();

    // A check on SIM replacements.
    everywhere("sim.swap", "Swap check");
    answer = (p, d) => (p === "sim.swap" && d.replacedBy.kind === "registration_agent" && d.walletBalance > 300 ? { decision: "reject", message: "Go to a service centre." } : { decision: "allow" });
    r = await run({ kinds: "sim_swap", incidents: 5, ordinary: 10 });
    expect(r.fraud).toMatchObject({ stopped: 5, through: 0 });
    expect(r.incidents.find((i) => i.kind === "fraud")!.summary).toBe("The SIM replacement was refused");
    expect(r.ordinary.blocked).toBe(0);
    unplug();

    // A weak-PIN check: the customer is made to choose a better PIN, and the thief cannot guess it.
    everywhere("pin.set", "PIN check");
    answer = (p, d) => (p === "pin.set" && (String(d.msisdn).endsWith(d.pin) || d.customer?.dateOfBirth.startsWith(d.pin)) ? { decision: "reject", message: "Too easy to guess." } : { decision: "allow" });
    r = await run({ kinds: "pin_guessing", incidents: 4, ordinary: 0 });
    expect(r.fraud).toMatchObject({ stopped: 4, through: 0 });
    expect(r.incidents[0]).toMatchObject({ stoppedAt: "pin.set", stoppedBy: "PIN check", summary: "The thief could not guess the PIN, and the wallet locked itself" });
    unplug();

    // Catching it late: the victim has paid, but the money is refused at the agent and can still be returned.
    // On MTN the agent's request is the step to watch; on Telecel and AT the customer starts the withdrawal, so it is the payment itself.
    everywhere("payment.request", "Cash-out watch");
    everywhere("payment.authorize", "Cash-out watch");
    const fresh = (iso: string) => Date.now() - Date.parse(iso) < 86_400_000;
    answer = (p, d) =>
      (p === "payment.request" && d.kind === "cash_out" && fresh(d.customer.walletOpenedAt)) || (p === "payment.authorize" && d.type === "cashout" && fresh(d.payer.walletOpenedAt)) ? { decision: "reject", message: "New wallet." } : { decision: "allow" };
    r = await run({ kinds: "relative_impersonation", incidents: 5, ordinary: 10 });
    expect(r.fraud).toMatchObject({ stopped: 0, contained: 5, through: 0 });
    expect(r.lost).toBe(0);
    expect(r.atRisk).toBeGreaterThan(0);
    expect(r.ordinary.blocked).toBe(0);
    unplug();
  });

  it("a standalone application connects to the Fraud API and is sent the incidents directly, at every step", async () => {
    const app = sim.connectApp(w, { name: "Swap Alert", url, kinds: "sim_swap" });
    expect(() => sim.connectApp(w, { name: "x", url: "ftp://nope" })).toThrow(/http/);
    // Nothing is plugged into any institution: only the application is asked.
    unplug();
    answer = (p, d) => (p === "pin.reset" && d.lastSimSwapAt ? { decision: "reject", message: "PIN reset right after a SIM replacement." } : { decision: "allow" });
    asked.length = 0;
    // With no kinds given, it is sent the kinds it said it was built for.
    const r = await run({ app: app.id, incidents: 5, ordinary: 6 });
    expect(r.against).toBe('The application "Swap Alert"');
    expect(r.kinds).toEqual(["sim_swap"]);
    expect(r.fraud).toMatchObject({ total: 5, stopped: 5, through: 0 });
    expect(r.stops[0]).toMatchObject({ step: "pin.reset", by: "Swap Alert", fraud: 5 });
    // It saw the whole of each incident, not one institution's step.
    expect(new Set(asked.map((a) => a.point))).toEqual(expect.objectContaining(new Set(["sim.register", "wallet.open", "sim.swap", "pin.reset"])));
    expect([...new Set(asked.map((a) => a.point))].length).toBeGreaterThan(5);
    // The institutions' own records of plugged-in APIs are not touched by an application under test.
    expect(count(w.db, "SELECT COUNT(*) AS n FROM integration_calls WHERE at > ?", Date.parse(r.startedAt) - 1)).toBe(0);
    // Earlier runs stay on record, and the console's view carries everything it shows.
    const view = sim.fraudResults(w);
    expect(view.runs.length).toBeGreaterThan(5);
    expect(view.apps).toMatchObject([{ name: "Swap Alert" }]);
    expect(view.running).toBe(false);
    sim.disconnectApp(w, app.id);
    expect(sim.listApps(w)).toEqual([]);
  });
});

describe("each network's own wallet menu and services", () => {
  let w: World;
  const net: Record<string, { code: string; a: string; b: string; agent: string; agentLine: string; point: string; pa: Person; pb: Person }> = {};
  const PIN = "4826";
  const bal = (m: string) => walletByMsisdn(w, m)!.balance;
  const agentRow = (code: string) => w.db.prepare("SELECT a.cash, x.balance FROM momo_agents a JOIN wallets x ON x.id = a.wallet_id WHERE a.code = ?").get(code) as { cash: number; balance: number };
  const backed = () => JSON.stringify(view(w, "bog")).includes('"backed":false') === false;
  /** Walks a session to its last screen, stopping when the session ends. */
  const walk = (msisdn: string, ...inputs: string[]) => {
    let sessionId: string | undefined;
    let last = { text: "", end: false, sessionId: "" };
    for (const input of inputs) {
      last = ussd(w, { sessionId, msisdn, input });
      sessionId = last.sessionId;
      if (last.end) break;
    }
    return last.text;
  };

  beforeAll(async () => {
    w = await resetWorld("team-02");
    const owner = person(w, "Yaw", "Asante", "1979-11-30");
    for (const t of ["mtn", "telecel", "at"] as const) {
      telco.generateSims(w, t, 6);
      const point = telco.onboardSimAgent(w, t, { card: owner.ghana_card, name: "Centre", kind: "service_centre", town: "Kumasi" }).id;
      const [pa, pb, pg] = [person(w, "Ama", `Owusu ${t}`), person(w, "Kofi", `Mensah ${t}`, "1985-01-02"), person(w, "Esi", `Agent ${t}`, "1980-02-02")];
      const [a, b, g] = [pa, pb, pg].map((p) => telco.registerSim(w, t, point, { card: p.ghana_card, fingerprint: p.fingerprint }).sim.msisdn);
      const agent = telco.onboardMomoAgent(w, t, { msisdn: g, name: `${t} Agent Shop`, town: "Kumasi", pin: "1357" }).code;
      pay.bankToWallet(w, { bank: "gcb", msisdn: g, amount: 2_000_000 });
      telco.adjustTill(w, t, agent, 1_000_000);
      net[t] = { code: getConfig(w.db, `telco.${t}`).menu.shortcode, a, b, agent, agentLine: g, point, pa, pb };
    }
  });

  it("the three networks have different menus, and each opens wallets its own way", () => {
    // MTN: from *170#. Telecel: from *558#, not from *110#. AT: an agent opens it and a starting PIN is texted.
    expect(walk(net.mtn.a, "*170#", "1", PIN, PIN)).toMatch(/now registered for MTN MoMo/);
    expect(walk(net.telecel.a, "*110#")).toMatch(/Dial \*558# to register/);
    expect(walk(net.telecel.a, "*558#", "1", PIN, PIN)).toMatch(/now registered for Telecel Cash/);
    expect(walk(net.telecel.a, "*558#")).toMatch(/already registered/);
    telco.agentRegisterWallet(w, "at", net.at.agent, { msisdn: net.at.a, card: net.at.pa.ghana_card, fingerprint: net.at.pa.fingerprint });
    const starting = lastSms(w, net.at.a).match(/starting AT Money PIN is (\d{4})/)![1];
    expect(walk(net.at.a, "*110#")).toMatch(/Enter the PIN sent to you by SMS/);
    expect(walk(net.at.a, "*110#", starting, PIN, PIN)).toMatch(/Your PIN is set/);
    expect(walletByMsisdn(w, net.at.a)).toMatchObject({ pin: PIN, kyc_tier: "medium" });
    for (const t of ["mtn", "telecel", "at"] as const) telco.agentRegisterWallet(w, t, net[t].agent, { msisdn: net[t].b, card: net[t].pb.ghana_card, fingerprint: net[t].pb.fingerprint, pin: "9753" });

    expect(walk(net.mtn.a, "*170#")).toBe("MTN MoMo\n1) Transfer Money\n2) MoMoPay & Pay Bill\n3) Airtime & Bundles\n4) Allow Cash Out\n5) Financial Services\n6) My Wallet");
    expect(walk(net.telecel.a, "*110#")).toBe("Telecel Cash\n1) Send Money\n2) Withdraw Cash\n3) Airtime & Bundles\n4) Make Payments\n5) Financial Services\n6) My Wallet\n7) Self Service");
    expect(walk(net.at.a, "*110#")).toBe("AT Money\n1) Send Money\n2) Cash Out\n3) Airtime & Bundles\n4) Pay Bill\n5) Buy Goods\n6) Financial Services\n7) My Wallet");
    // Every option on every menu leads somewhere that exists.
    for (const t of ["mtn", "telecel", "at"] as const) expect(validateSurface(`telco.${t}`, defaultTelco(t))).toMatchObject({ ok: true });
    for (const t of ["mtn", "telecel", "at"] as const) telco.agentCashIn(w, t, net[t].agent, { msisdn: net[t].a, amount: 3000, pin: "1357" });
  });

  it("money is sent the same way on each, with the network's own steps and fees", () => {
    // MTN asks for the number twice; Telecel and AT do not.
    expect(walk(net.mtn.a, "*170#", "1", "1", net.mtn.b, net.mtn.b, "50", "lunch", PIN)).toMatch(/GHS 50.00 sent to Kofi Mensah mtn. Fee GHS 0.38/);
    expect(walk(net.telecel.a, "*110#", "1", "1", net.telecel.b, "50", "lunch", PIN)).toMatch(/GHS 50.00 sent to Kofi Mensah telecel. Fee GHS 0.00/);
    expect(walk(net.at.a, "*110#", "1", "1", net.at.b, "50", "lunch", PIN)).toMatch(/GHS 50.00 sent to Kofi Mensah at. Fee GHS 0.38/);
    // Across networks, through the switch.
    expect(walk(net.telecel.a, "*110#", "1", "2", net.mtn.b, "200", "rent", PIN)).toMatch(/GHS 200.00 sent to Kofi Mensah mtn. Fee GHS 1.00/);
    expect(walk(net.at.a, "*110#", "1", "2", net.telecel.b, "20", "x", PIN)).toMatch(/sent to Kofi Mensah telecel/);
    expect(walk(net.telecel.a, "*110#", "1", "1", net.telecel.b, "50", "x", "0000")).toMatch(/Wrong PIN/);
  });

  it("on Telecel and AT the customer starts a cash withdrawal with the agent's number; on MTN the agent asks", () => {
    for (const t of ["telecel", "at"] as const) {
      const n = net[t];
      const [before, shop] = [bal(n.a), agentRow(n.agent)];
      // The screen before the PIN names the agent and the fee.
      expect(walk(n.a, n.code, "2", "1", n.agent, "200")).toMatch(new RegExp(`Withdraw GHS200.00 from ${t} Agent Shop, Kumasi\\nFee: GHS2.00`));
      expect(walk(n.a, n.code, "2", "1", n.agent, "200", PIN)).toMatch(new RegExp(`GHS 200.00 cashed out at ${t} Agent Shop. Fee GHS 2.00`));
      expect(bal(n.a)).toBe(before - 20200);
      // The agent's till pays out, its float rises by the amount and its commission, and it is told by text.
      expect(agentRow(n.agent)).toEqual({ cash: shop.cash - 20000, balance: shop.balance + 20000 + 80 });
      expect(lastSms(w, n.agentLine)).toMatch(/Cash out of GHS 200.00 approved by Ama Owusu/);
      // The agent's phone number works as well as the agent number; anything else is refused before the amount is asked.
      expect(walk(n.a, n.code, "2", "1", n.agentLine, "50", PIN)).toMatch(/GHS 50.00 cashed out/);
      expect(walk(n.a, n.code, "2", "1", "999999")).toMatch(/That is not a .* agent number\nEnter agent number/);
      expect(walk(n.a, n.code, "2", "1", net.mtn.agent)).toMatch(/not a .* agent number/);
      // An agent cannot pull money from a customer here.
      expect(() => telco.agentRequestCashOut(w, t, n.agent, { msisdn: n.a, amount: 50, card: n.pa.ghana_card })).toThrow(/the customer starts the withdrawal on their own phone/);
    }
    // MTN: the agent sends the request, the customer allows it under option 4.
    telco.agentRequestCashOut(w, "mtn", net.mtn.agent, { msisdn: net.mtn.a, amount: 100, card: net.mtn.pa.ghana_card });
    expect(lastSms(w, net.mtn.a)).toMatch(/Dial \*170# and choose option 4 to approve/);
    expect(walk(net.mtn.a, "*170#", "4", "1", "1", PIN)).toMatch(/GHS 100.00 cashed out at mtn Agent Shop/);
    expect(walk(net.mtn.a, "*170#", "2")).not.toMatch(/Withdraw/);
  });

  it("cash machines pay out against a voucher from the phone, once, at the banks that accept it", async () => {
    const svc = await import("../src/engine/services");
    const n = net.telecel;
    const before = bal(n.a);
    expect(walk(n.a, "*110#", "2", "2", "305", PIN)).toMatch(/multiples of GHS 10/);
    expect(walk(n.a, "*110#", "2", "2", "300", PIN)).toMatch(/Voucher \d{6} for GHS 300.00. Fee GHS 3.00. Use it at any Ecobank Ghana or Absa Bank Ghana cash machine/);
    const code = lastSms(w, n.a).match(/voucher is (\d{6})/)![1];
    // Nothing has left the wallet yet.
    expect(bal(n.a)).toBe(before);
    expect(() => svc.atmWithdraw(w, "gcb", { msisdn: n.a, code })).toThrow(/work at Ecobank Ghana and Absa Bank Ghana cash machines/);
    expect(() => svc.atmWithdraw(w, "ecobank", { msisdn: n.b, code })).toThrow(/do not match/);
    const vault = balanceOf(w, "vault:ecobank");
    expect(svc.atmWithdraw(w, "ecobank", { msisdn: n.a, code }).message).toBe("Take your cash: GHS 300.00.");
    expect(bal(n.a)).toBe(before - 30300);
    expect(balanceOf(w, "vault:ecobank")).toBe(vault + 30000);
    expect(lastSms(w, n.a)).toMatch(/You withdrew GHS 300.00 at a Ecobank Ghana cash machine/);
    expect(() => svc.atmWithdraw(w, "ecobank", { msisdn: n.a, code })).toThrow(/already been used/);
    // A new voucher replaces an unused one, and a voucher runs out.
    walk(n.a, "*110#", "2", "2", "100", PIN);
    const first = lastSms(w, n.a).match(/voucher is (\d{6})/)![1];
    walk(n.a, "*110#", "2", "2", "100", PIN);
    expect(() => svc.atmWithdraw(w, "absa", { msisdn: n.a, code: first })).toThrow(/expired/);
    w.db.prepare("UPDATE atm_vouchers SET expires_at = 1 WHERE status = 'active'").run();
    expect(() => svc.atmWithdraw(w, "absa", { msisdn: n.a, code: lastSms(w, n.a).match(/voucher is (\d{6})/)![1] })).toThrow(/expired/);
    // From the bank's console, and on AT too.
    walk(net.at.a, "*110#", "2", "2", "50", PIN);
    const r = resolveSystem(["bank", "absa"]).actions.atm_withdraw(w, { msisdn: net.at.a, code: lastSms(w, net.at.a).match(/voucher is (\d{6})/)![1] }) as { message: string };
    expect(r.message).toBe("Take your cash: GHS 50.00.");
    expect(view<{ atm: { wallets: string[]; paid: number } }>(w, "bank", "absa").atm).toEqual({ wallets: ["Telecel Cash", "AT Money"], paid: 1 });
    // A bank that is not one of a network's partners accepts none.
    expect(view<{ atm: { wallets: string[] } }>(w, "bank", "gcb").atm.wallets).toEqual([]);
  });

  it("airtime, data bundles and bills are bought from the wallet on every network", async () => {
    const svc = await import("../src/engine/services");
    const path = { mtn: { bills: ["2", "2"], fin: "5", wallet: "6" }, telecel: { bills: ["4", "2"], fin: "5", wallet: "6" }, at: { bills: ["4"], fin: "6", wallet: "7" } };
    for (const t of ["mtn", "telecel", "at"] as const) {
      const n = net[t];
      const before = bal(n.a);
      expect(walk(n.a, n.code, "3", "1", "1", "10", PIN)).toMatch(/GHS 10.00 airtime bought for your number/);
      expect(walk(n.a, n.code, "3", "1", "2", n.b, "5", PIN)).toMatch(new RegExp(`GHS 5.00 airtime bought for ${n.b}`));
      expect(lastSms(w, n.b)).toMatch(/You have received GHS 5.00 airtime/);
      // Airtime is for the network's own numbers.
      expect(walk(n.a, n.code, "3", "1", "2", net[t === "mtn" ? "at" : "mtn"].b, "5", PIN)).toMatch(/Enter an active .* number/);
      expect(walk(n.a, n.code, "3", "2")).toMatch(/Buy Data Bundle\n1\) Daily 450MB GHS3\n2\) Weekly 1.2GB GHS10/);
      expect(walk(n.a, n.code, "3", "2", "2")).toMatch(/Buy Weekly 1.2GB for GHS10.00\nEnter PIN/);
      expect(walk(n.a, n.code, "3", "2", "2", PIN)).toMatch(/Weekly 1.2GB bought for your number/);
      expect(svc.lineBalance(w, n.a)).toMatchObject({ airtime: 1000, dataMb: 1200 });
      expect(svc.lineBalance(w, n.b)).toMatchObject({ airtime: 500, dataMb: 0 });
      expect(walk(n.a, "*124#")).toMatch(/Airtime: GHS 10.00\nData: 1200MB/);
      expect(walk(n.a, n.code, "3", "3")).toMatch(/Airtime: GHS 10.00/);
      // A bill: the biller, the account, the amount. Prepaid electricity comes back with a token.
      expect(walk(n.a, n.code, ...path[t].bills)).toMatch(/Pay Bill\n1\) ECG Prepaid\n2\) Ghana Water\n3\) DStv/);
      expect(walk(n.a, n.code, ...path[t].bills, "1")).toBe("Enter meter number");
      expect(walk(n.a, n.code, ...path[t].bills, "1", "24178833", "60", PIN)).toMatch(/GHS 60.00 paid to ECG Prepaid for 24178833. Token: \d{4}-\d{4}-\d{4}-\d{4}-\d{4}/);
      expect(lastSms(w, n.a)).toMatch(/You paid GHS 60.00 to ECG Prepaid for 24178833. Token:/);
      expect(walk(n.a, n.code, ...path[t].bills, "3", "x")).toMatch(/Invalid number\nEnter smartcard number/);
      expect(walk(n.a, n.code, ...path[t].bills, "3", "7023456789", "150", PIN)).toMatch(/GHS 150.00 paid to DStv for 7023456789/);
      expect(bal(n.a)).toBe(before - 1000 - 500 - 1000 - 6000 - 15000);
      // The network has the airtime money as its own, and owes the billers theirs.
      expect(balanceOf(w, `airtime:${t}`)).toBe(2500);
      expect(balanceOf(w, `billers:${t}`)).toBe(21000);
      expect(view<{ bills: { biller: string; account: string; amount: number }[] }>(w, "telco", t).bills.map((b) => b.biller).sort()).toEqual(["DStv", "ECG Prepaid"]);
      // Checking an agent before trusting one.
      const verify = t === "mtn" ? ["6", "6"] : t === "telecel" ? ["7", "1"] : ["7", "5"];
      expect(walk(n.a, n.code, ...verify, n.agent)).toMatch(new RegExp(`Agent ${n.agent}: ${t} Agent Shop, Kumasi. Registered`));
      expect(walk(n.a, n.code, ...verify, "123456")).toMatch(/is NOT a registered/);
      // Bank to wallet needs a bank account in the same name.
      expect(walk(n.a, n.code, path[t].fin, "1", "2", "100", PIN)).toMatch(/No bank account is linked to your wallet/);
      const acct = openAccount(w, "fidelity", { card: n.pa.ghana_card, fingerprint: n.pa.fingerprint });
      pay.bankCash(w, { bank: "fidelity", account: acct.id, amount: 50000, kind: "deposit" });
      expect(walk(n.a, n.code, path[t].fin, "1", "2")).toMatch(new RegExp(`Move money from Fidelity Bank ${acct.account_no} to your wallet`));
      const had = bal(n.a);
      expect(walk(n.a, n.code, path[t].fin, "1", "2", "100", PIN)).toMatch(/GHS 100.00 sent to Ama Owusu/);
      expect(bal(n.a)).toBe(had + 10000);
      expect(walk(n.a, n.code, path[t].fin, "2")).toMatch(/run by a partner/);
      expect(walk(n.a, n.code, path[t].wallet, "2", PIN)).toMatch(/\+100.00/);
    }
    // Every cedi is still backed, with airtime and bill money counted, and the books balance.
    expect(backed()).toBe(true);
    expect(count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM (SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount) != 0)")).toBe(0);
  });

  it("an API plugged into a network is asked about these too, and a warning waits for the customer", async () => {
    const http = await import("node:http");
    const integrations = await import("../src/engine/integrations");
    const asked: { point: string; data: { type: string; payee: Record<string, unknown> } }[] = [];
    const api = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body);
        asked.push(j);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(j.data.type === "cashout" ? { decision: "warn", message: "Are you at the agent's shop?" } : j.data.type === "airtime" && j.data.amount > 100 ? { decision: "reject", message: "Large airtime purchase blocked." } : { decision: "allow" }));
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    integrations.addIntegration(w, "telecel", { point: "payment.authorize", name: "Guard", url: `http://127.0.0.1:${(api.address() as import("node:net").AddressInfo).port}/` });
    const n = net.telecel;
    const step = (input: string, sessionId?: string) => integrations.locked(w, () => ussd(w, { sessionId, msisdn: n.a, input }));
    const run = async (...inputs: string[]) => {
      let s = await step("*110#");
      for (const i of inputs) s = await step(i, s.sessionId);
      return s;
    };
    const before = bal(n.a);
    // A withdrawal: the warning is shown, and nothing moves until the customer continues.
    let s = await run("2", "1", n.agent, "100", PIN);
    expect(s).toMatchObject({ end: false });
    expect(s.text).toBe("Are you at the agent's shop?\n1) Continue\n2) Cancel");
    expect(bal(n.a)).toBe(before);
    s = await step("1", s.sessionId);
    expect(s.text).toMatch(/GHS 100.00 cashed out/);
    // Airtime and bills are payments like any other to the API.
    expect((await run("3", "1", "1", "150", PIN)).text).toBe("Large airtime purchase blocked.");
    expect((await run("3", "1", "1", "20", PIN)).text).toMatch(/GHS 20.00 airtime bought/);
    expect((await run("4", "2", "2", "ACC-778", "35", PIN)).text).toMatch(/GHS 35.00 paid to Ghana Water/);
    expect((await run("2", "2", "50", PIN)).text).toMatch(/Voucher \d{6}/);
    expect(asked.map((a) => `${a.data.type}:${a.data.payee.kind ?? a.data.payee.walletType}`)).toEqual(["cashout:agent", "airtime:airtime", "airtime:airtime", "bill:bill", "atm_withdrawal:cash_machine"]);
    for (const p of integrations.listIntegrations(w, "telecel")) integrations.removeIntegration(w, "telecel", p.id);
    api.close();
  });

  it("the totals the consoles keep stay right when a payment is undone part-way, and move the moment money moves", async () => {
    const { tx } = await import("../src/engine/db");
    const { post } = await import("../src/engine/ledger");
    const added = (account: string) => count(w.db, "SELECT COALESCE(SUM(amount),0) AS n FROM postings WHERE account = ?", account);
    const mtn = () => view<{ stats: { revenue: number } }>(w, "telco", "mtn").stats.revenue;
    const switchRouted = () => view<{ stats: { routed: number } }>(w, "switch").stats.routed;
    const fees = balanceOf(w, "fee:mtn");
    expect(fees).toBe(added("fee:mtn"));
    const [revenue, routed] = [mtn(), switchRouted()];
    // A payment that fails after its entries were written leaves nothing behind, in the ledger or in what was kept.
    expect(() =>
      tx(w.db, () => {
        post(w, "tx_undone", [["fee:mtn", 500], ["emoney:mtn", -500]]);
        expect(balanceOf(w, "fee:mtn")).toBe(fees + 500);
        throw new Error("stopped part-way");
      }),
    ).toThrow("stopped part-way");
    expect(balanceOf(w, "fee:mtn")).toBe(fees);
    expect(mtn()).toBe(revenue);
    // A real payment shows at once: the fee on the network's screen, the payment on the switch's.
    expect(walk(net.mtn.a, "*170#", "1", "2", net.telecel.b, net.telecel.b, "40", "x", PIN)).toMatch(/GHS 40.00 sent to Kofi Mensah telecel/);
    expect(balanceOf(w, "fee:mtn")).toBeGreaterThan(fees);
    expect(balanceOf(w, "fee:mtn")).toBe(added("fee:mtn"));
    expect(mtn()).toBeGreaterThan(revenue);
    expect(switchRouted()).toBe(routed + 1);
    for (const account of ["switch:mtn", "switch:telecel", "emoney:mtn", "hold:mtn"]) expect(balanceOf(w, account)).toBe(added(account));
    expect(totals(w).kept).toEqual(totals(w).counted);
    expect(backed()).toBe(true);
  });

  it("a world made before each network had its own menu is brought up to date, unless its menu was edited", async () => {
    const { EARLIER_MENUS } = await import("../src/engine/config/defaults");
    const worlds = await import("../src/engine/worlds");
    const { setMeta } = await import("../src/engine/db");
    const old = await resetWorld("team-01");
    // Put the world back as it was: the shared menu on every network, and the old wording of the request text.
    for (const t of ["mtn", "telecel", "at"] as const) {
      const cfg = structuredClone(getConfig(old.db, `telco.${t}`)) as Record<string, unknown> & ReturnType<typeof defaultTelco>;
      cfg.menu = structuredClone(EARLIER_MENUS[t]);
      if (t === "at") (cfg.menu.nodes.not_available as { text: string }).text = "Edited by the team.";
      cfg.notifications.approval_prompt = { enabled: true, template: "Dial and choose option 4 to approve." };
      for (const k of ["cashOut", "registration", "bundles", "billers", "atm"]) delete cfg[k];
      old.db.prepare("UPDATE config SET value = ?, version = version + 1 WHERE surface = ?").run(JSON.stringify(cfg), `telco.${t}`);
    }
    setMeta(old.db, "menus", 1);
    worlds.upgradeMenus(old.db);
    const main = (t: string) => (getConfig(old.db, `telco.${t}`).menu.nodes.main as { options: { label: string }[] }).options.map((o) => o.label);
    expect(main("telecel")).toContain("Self Service");
    expect(getConfig(old.db, "telco.telecel")).toMatchObject({ cashOut: "customer_starts", registration: { code: "*558#" }, selfRegistration: true });
    expect(getConfig(old.db, "telco.telecel").notifications.approval_prompt!.template).toMatch(/choose 6 \(My Wallet\), then 4 \(My Approvals\)/);
    expect(main("mtn")).toEqual(["Transfer Money", "MoMoPay & Pay Bill", "Airtime & Bundles", "Allow Cash Out", "Financial Services", "My Wallet"]);
    // AT's menu had been edited, so it is left as the team made it; it still gets the lists the new services read.
    expect(main("at")).toContain("Approve Cash Out");
    expect(getConfig(old.db, "telco.at").cashOut).toBeUndefined();
    expect(getConfig(old.db, "telco.at").bundles).toHaveLength(4);
    // Running it again changes nothing.
    const again = JSON.stringify(getConfig(old.db, "telco.telecel"));
    worlds.upgradeMenus(old.db);
    expect(JSON.stringify(getConfig(old.db, "telco.telecel"))).toBe(again);
    await resetWorld("team-01");
  });
});
