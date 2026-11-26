import { locked } from "./integrations";
import { normalizeCard } from "./nia";
import { bankToWallet } from "./payments";
import * as telcoOps from "./telco";
import { SimError, TELCO_INFO, need, type Telco } from "./util";
import type { World } from "./world";

/**
 * Opens a mobile money agent in one step, for a person who has a Ghana Card: the network's head office
 * registers a new business line to them, the network turns that line into an agent with its own agent
 * number, and, if asked, a bank pays a starting float onto it. Each part is done the way it is done at the
 * consoles, in a turn of its own, so any API plugged into those steps is asked as usual.
 */
export async function openMomoAgent(
  w: World,
  telco: Telco,
  input: { card?: string; fingerprint?: string; otp?: string; name?: string; town?: string; pin?: string; float?: unknown },
) {
  // Everything that can be checked before the line is registered is checked first, so a typo does not leave a spare line behind.
  const name = need(input.name?.trim(), "Business name");
  const town = need(input.town?.trim(), "Town");
  if (!/^\d{4}$/.test(String(input.pin ?? ""))) throw new SimError("The agent PIN must be 4 digits");
  const float = input.float === undefined || input.float === "" ? 0 : Number(input.float);
  if (!Number.isFinite(float) || float < 0 || float > 50000) throw new SimError("Choose a starting float between GHS 0 and GHS 50,000");
  const card = need(input.card?.trim(), "Ghana Card number");
  if (!w.db.prepare("SELECT 1 FROM persons WHERE ghana_card = ?").get(normalizeCard(card))) throw new SimError("NIA has no Ghana Card with that number. Enrol the owner at NIA first.");

  const hq = telcoOps.headOfficeId(telco);
  await locked(w, () => telcoOps.readyHeadOffice(w, telco));
  const line = (await locked(w, () => telcoOps.registerSim(w, telco, hq, { card, fingerprint: input.fingerprint, otp: input.otp }))).sim.msisdn;

  let agent;
  try {
    agent = await locked(w, () => telcoOps.onboardMomoAgent(w, telco, { msisdn: line, name, town, pin: input.pin }));
  } catch (e) {
    if (!(e instanceof SimError)) throw e;
    throw new SimError(`${e.message}. The business line ${line} is registered to the owner: finish in the ${TELCO_INFO[telco].name} back office → Mobile money agents, using that line.`);
  }
  if (float > 0) await locked(w, () => bankToWallet(w, { bank: "gcb", msisdn: line, amount: Math.round(float * 100), reference: "Starting float" }));
  return { code: agent.code, name: agent.name, town: agent.town, msisdn: line, float };
}
