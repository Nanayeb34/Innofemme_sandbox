// Builds a small world from nothing in a throwaway directory and prints each step. Never touches real team worlds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "momo-smoke-"));

async function main() {
  const { resetWorld } = await import("../src/engine/worlds");
  const { enrol } = await import("../src/engine/nia");
  const telco = await import("../src/engine/telco");
  const { openAccount } = await import("../src/engine/bank");
  const pay = await import("../src/engine/payments");
  const { settle, positions } = await import("../src/engine/switch");
  const { ussd } = await import("../src/engine/ussd");
  const { walletByMsisdn } = await import("../src/engine/ledger");
  const { cedis } = await import("../src/engine/util");

  const w = await resetWorld("team-01");
  const step = (s: string) => console.log(`\n== ${s}`);
  const dial = (msisdn: string, ...inputs: string[]) => {
    let sessionId: string | undefined;
    for (const input of inputs) {
      const r = ussd(w, { sessionId, msisdn, input });
      sessionId = r.sessionId;
      console.log(`> ${input}\n${r.text}${r.end ? "  [END]" : ""}`);
    }
  };

  step("NIA issues Ghana Cards");
  const ama = enrol(w, { firstNames: "Ama", surname: "Owusu", dob: "1994-03-12", gender: "F", region: "Ashanti", town: "Kumasi" });
  const yaw = enrol(w, { firstNames: "Yaw", surname: "Asante", dob: "1980-07-01", gender: "M", region: "Ashanti", town: "Suame" });
  const kofi = enrol(w, { firstNames: "Kofi", surname: "Mensah", dob: "1988-11-23", gender: "M", region: "Greater Accra", town: "Madina" });
  console.log(ama.ghana_card, yaw.ghana_card, kofi.ghana_card);

  step("Telcos add SIM stock and authorise registration points");
  for (const t of ["mtn", "at"] as const) telco.generateSims(w, t, 5);
  const mtnPoint = telco.onboardSimAgent(w, "mtn", { card: kofi.ghana_card, name: "Adum Service Centre", kind: "service_centre", town: "Kumasi" }).id;
  const atPoint = telco.onboardSimAgent(w, "at", { card: kofi.ghana_card, name: "Madina Registration Agent", kind: "registration_agent", town: "Madina" }).id;

  step("Registration points register SIMs against the Ghana Card");
  const amaNo = telco.registerSim(w, "mtn", mtnPoint, { card: ama.ghana_card, fingerprint: ama.fingerprint }).sim.msisdn;
  const yawNo = telco.registerSim(w, "mtn", mtnPoint, { card: yaw.ghana_card, fingerprint: yaw.fingerprint }).sim.msisdn;
  const kofiNo = telco.registerSim(w, "at", atPoint, { card: kofi.ghana_card, fingerprint: kofi.fingerprint }).sim.msisdn;
  console.log({ amaNo, yawNo, kofiNo });

  step("MTN onboards a mobile money agent; the agent buys float at a bank");
  const agent = telco.onboardMomoAgent(w, "mtn", { msisdn: yawNo, name: "Yaw Mobile Money Centre", town: "Suame", pin: "4321" }).code;
  const acct = openAccount(w, "gcb", { card: yaw.ghana_card, fingerprint: yaw.fingerprint });
  pay.bankCash(w, { bank: "gcb", account: acct.id, amount: 500000, kind: "deposit" });
  console.log(pay.bankToWallet(w, { bank: "gcb", fromAccount: acct.id, msisdn: yawNo, amount: 300000 }).message);

  step("Customers open wallets from their phones");
  dial(amaNo, "*170#", "1", "1234", "1234");
  dial(kofiNo, "*110#", "1", "5678", "5678");

  step("Cash-in at the agent, then a cross-network transfer");
  console.log(telco.agentCashIn(w, "mtn", agent, { msisdn: amaNo, amount: 400, pin: "4321" }).message);
  dial(amaNo, "*170#", "1", "2", kofiNo, kofiNo, "50", "lunch", "1234");
  console.log(w.db.prepare("SELECT step, detail FROM switch_log ORDER BY id DESC LIMIT 3").all());

  step("Settlement");
  console.log(positions(w).filter((p) => p.position).map((p) => `${p.name}: ${p.position > 0 ? "owes" : "is owed"} ${cedis(Math.abs(p.position))}`));
  settle(w);
  console.log("Ama", cedis(walletByMsisdn(w, amaNo)!.balance), "Kofi", cedis(walletByMsisdn(w, kofiNo)!.balance));
  const unbalanced = w.db.prepare("SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount) != 0").all();
  console.log("unbalanced transactions:", unbalanced.length);
}
main();
