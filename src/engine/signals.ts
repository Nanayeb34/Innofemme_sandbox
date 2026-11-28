import { personById } from "./nia";
import { getSim } from "./telco";
import { HOUR, SimError, TELCO_INFO, normalizeMsisdn, type Telco } from "./util";
import { walletByMsisdn } from "./ledger";
import type { World } from "./world";

/**
 * What a network can tell a licensed partner about one of its own numbers: who it is registered to,
 * whether its SIM was replaced recently, and whether details the partner holds match the network's
 * records. A network answers only for its own subscribers.
 */

function own(w: World, telco: Telco, input: unknown) {
  const msisdn = normalizeMsisdn(String(input ?? ""));
  if (!/^0\d{9}$/.test(msisdn)) throw new SimError("phoneNumber must be a mobile number");
  const sim = getSim(w, msisdn);
  if (!sim || sim.telco !== telco || sim.status === "in_stock") throw new SimError(`${msisdn} is not a ${TELCO_INFO[telco].name} subscriber`, 404);
  return sim;
}

/**
 * Whether a number is in service, since when, and whether it has a mobile money wallet. It does not say who the
 * number belongs to: a network does not hand out its subscribers' names. A partner that holds a name checks it
 * with kyc-match, which answers only true or false.
 */
export function subscriber(w: World, telco: Telco, msisdn: unknown) {
  const sim = own(w, telco, msisdn);
  const wallet = walletByMsisdn(w, sim.msisdn);
  return {
    msisdn: sim.msisdn,
    network: TELCO_INFO[telco].name,
    status: sim.status,
    registeredSince: sim.registered_at ? new Date(sim.registered_at).toISOString() : null,
    mobileMoney: wallet ? { registered: true, status: wallet.status, accountType: wallet.owner_type === "person" ? "customer" : wallet.owner_type } : { registered: false },
  };
}

/** Was this number moved to a new SIM card within the last `maxAgeHours`? (The usual question before trusting a one-time code.) */
export function simSwapCheck(w: World, telco: Telco, input: { phoneNumber?: unknown; maxAge?: unknown }) {
  const sim = own(w, telco, input.phoneNumber);
  const maxAge = Number(input.maxAge ?? 240);
  if (!Number.isFinite(maxAge) || maxAge < 1 || maxAge > 2400) throw new SimError("maxAge is in hours, between 1 and 2400");
  return { swapped: !!sim.last_swap_at && w.now - sim.last_swap_at <= maxAge * HOUR };
}

/** When the number last moved to a new SIM card. A line that has never been replaced reports when it was first registered. */
export function simSwapDate(w: World, telco: Telco, input: { phoneNumber?: unknown }) {
  const sim = own(w, telco, input.phoneNumber);
  const at = sim.last_swap_at ?? sim.registered_at;
  return { latestSimChange: at ? new Date(at).toISOString() : null };
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const words = (s: unknown) => norm(s).split(" ").filter(Boolean).sort().join(" ");

/**
 * Compares details a partner holds about a customer with the network's own records, field by field.
 * It answers only true or false for each field supplied; it never returns the record itself.
 */
export function kycMatch(w: World, telco: Telco, input: Record<string, unknown>) {
  const sim = own(w, telco, input.phoneNumber);
  const p = sim.person_id ? personById(w, sim.person_id) : undefined;
  const check = (supplied: unknown, actual: string | undefined, same: (a: unknown, b: string) => boolean = (a, b) => norm(a) === norm(b)) =>
    supplied === undefined || supplied === null || supplied === "" ? undefined : !p || actual === undefined ? "not_available" : same(supplied, actual) ? "true" : "false";
  const out: Record<string, string | undefined> = {
    idDocumentMatch: check(input.idDocument, p?.ghana_card, (a, b) => String(a).toUpperCase().replace(/[^A-Z0-9]/g, "") === b.replace(/[^A-Z0-9]/g, "")),
    nameMatch: check(input.name, p ? `${p.first_names} ${p.surname}` : undefined, (a, b) => words(a) === words(b)),
    givenNameMatch: check(input.givenName, p?.first_names),
    familyNameMatch: check(input.familyName, p?.surname),
    birthdateMatch: check(input.birthdate, p?.dob),
    genderMatch: check(input.gender, p?.gender, (a, b) => norm(a).charAt(0) === b.toLowerCase()),
  };
  const supplied = Object.entries(out).filter(([, v]) => v !== undefined);
  if (!supplied.length) throw new SimError("Send at least one detail to compare: idDocument, name, givenName, familyName, birthdate or gender");
  return Object.fromEntries(supplied);
}
