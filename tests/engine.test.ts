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
