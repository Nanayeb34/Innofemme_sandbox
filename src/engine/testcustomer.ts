import { randomInt } from "node:crypto";
import { getConfig } from "./config/store";
import { locked } from "./integrations";
import { count } from "./db";
import { walletByMsisdn } from "./ledger";
import { enrol } from "./nia";
import { bankToWallet } from "./payments";
import { FIRST_F, FIRST_M, PLACES, SURNAMES } from "./simulate";
import * as telcoOps from "./telco";
import { SimError, TELCO_INFO, isTelco, type Telco } from "./util";
import { audit, type World } from "./world";

const pick = <T>(list: readonly T[]) => list[randomInt(list.length)];

/**
 * A customer ready to use, in one step: a new person with a Ghana Card, a number registered to them, a
 * wallet on medium KYC with a PIN you are told, and some money in it. Each part is done the way the
 * institutions do it (NIA enrols, a service centre registers the SIM, the wallet is opened from the phone,
 * a bank pays the money in), so everything that normally happens along the way happens here too,
 * including any API plugged into those steps. Works in an empty world and in the simulated country.
 *
 * Each part takes its own turn on the world, as if someone had done them one after another at the
 * consoles. That matters when an API is plugged in: a part that stops to ask it is run again with the
 * answer, and must then be exactly the same request. So everything left to chance (the name, the
 * birthday, the PIN) is chosen once, here, before any part runs.
 */
export async function createTestCustomer(w: World, input: { network?: unknown; amount?: unknown }) {
  const telco: Telco = isTelco(String(input.network ?? "mtn")) ? (String(input.network ?? "mtn") as Telco) : "mtn";
  const amount = input.amount === undefined || input.amount === "" ? 500 : Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 5000) throw new SimError("Choose a starting balance between GHS 0 and GHS 5,000");

  // 1. The person. A name and birthday already on the register belong to someone else, so try another.
  let person: ReturnType<typeof enrol> | undefined;
  for (let i = 0; i < 20 && !person; i++) {
    const woman = randomInt(2) === 0;
    const place = pick(PLACES);
    const who = {
      firstNames: pick(woman ? FIRST_F : FIRST_M),
      surname: pick(SURNAMES),
      dob: `${1965 + randomInt(38)}-${String(1 + randomInt(12)).padStart(2, "0")}-${String(1 + randomInt(28)).padStart(2, "0")}`,
      gender: woman ? "F" : "M",
      region: place.region,
      town: pick(place.towns),
    };
    try {
      person = await locked(w, () => enrol(w, who));
    } catch (e) {
      if (!(e instanceof SimError) || !/already enrolled/.test(e.message)) throw e;
    }
  }
  if (!person) throw new SimError("Could not enrol a new person. Please try again.");
  const owner = person;

  // 2. A service centre to register the number at, and a SIM to give out. In an empty world that is the network's own head office.
  const centre = await locked(
    w,
    () =>
      (w.db.prepare("SELECT id FROM sim_agents WHERE telco = ? AND kind = 'service_centre' AND status = 'active' ORDER BY created_at LIMIT 1").get(telco) as { id: string } | undefined)?.id ??
      telcoOps.headOfficeId(telco),
  );
  await locked(w, () => {
    if (centre === telcoOps.headOfficeId(telco)) telcoOps.readyHeadOffice(w, telco);
    else if (!count(w.db, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", telco)) telcoOps.generateSims(w, telco, 10);
  });
  const msisdn = (await locked(w, () => telcoOps.registerSim(w, telco, centre, { card: owner.ghana_card, fingerprint: owner.fingerprint }))).sim.msisdn;

  // 3. The wallet: opened with a PIN that is not an obvious one, then raised to medium KYC as a service centre would after checking the card.
  let pin = "";
  while (!pin || /^(\d)\1{3}$/.test(pin) || ["1234", "2580", "4321", msisdn.slice(-4), owner.dob.slice(0, 4)].includes(pin)) pin = String(randomInt(10000)).padStart(4, "0");
  await locked(w, () => telcoOps.selfRegisterWallet(w, msisdn, pin));
  await locked(w, () => telcoOps.upgradeTier(w, telco, msisdn, "medium", centre));
  // 4. Money in the wallet, paid in at a bank.
  if (amount > 0) await locked(w, () => bankToWallet(w, { bank: "gcb", msisdn, amount: Math.round(amount * 100), reference: "Opening money" }));

  const name = `${owner.first_names} ${owner.surname}`;
  await locked(w, () => audit(w, "hub", "test_customer", `Created a ready customer: ${name}, ${msisdn} on ${TELCO_INFO[telco].name}`));
  return {
    name,
    ghanaCard: owner.ghana_card,
    fingerprint: owner.fingerprint,
    dateOfBirth: owner.dob,
    number: msisdn,
    network: telco,
    networkName: TELCO_INFO[telco].name,
    walletCode: getConfig(w.db, `telco.${telco}`).menu.shortcode,
    pin,
    kyc: "medium",
    balance: (walletByMsisdn(w, msisdn)?.balance ?? 0) / 100,
  };
}
