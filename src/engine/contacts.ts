import { getSim } from "./telco";
import { SimError, normalizeMsisdn } from "./util";
import type { World } from "./world";

/**
 * A phone's address book. A contact is only a name the phone's owner saved for a number: it is kept on that
 * phone, and nobody else (no network, no other phone) sees it. Saving the same number again renames it.
 */

export interface Contact {
  number: string;
  name: string;
}

const isNumber = (s: string) => /^0\d{9}$/.test(s);

export function listContacts(w: World, msisdn: string): Contact[] {
  return w.db.prepare("SELECT number, name FROM contacts WHERE msisdn = ? ORDER BY name COLLATE NOCASE, number").all(normalizeMsisdn(msisdn)) as unknown as Contact[];
}

export function saveContact(w: World, msisdn: string, req: { name?: unknown; number?: unknown; was?: unknown }): Contact {
  const phone = getSim(w, normalizeMsisdn(msisdn));
  if (!phone) throw new SimError("This phone has no SIM card.");
  const name = String(req.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new SimError("Give the contact a name.");
  const number = normalizeMsisdn(String(req.number ?? ""));
  if (!isNumber(number)) throw new SimError("That is not a valid mobile number. Use 10 digits, such as 024 123 4567.");
  if (number === phone.msisdn) throw new SimError("That is this phone's own number.");
  const count = (w.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE msisdn = ?").get(phone.msisdn) as { n: number }).n;
  const exists = w.db.prepare("SELECT 1 FROM contacts WHERE msisdn = ? AND number = ?").get(phone.msisdn, number);
  if (!exists && count >= 500) throw new SimError("This phone's contacts are full (500).");
  // Editing a contact may change its number: the old entry goes.
  const was = req.was ? normalizeMsisdn(String(req.was)) : "";
  if (was && was !== number) w.db.prepare("DELETE FROM contacts WHERE msisdn = ? AND number = ?").run(phone.msisdn, was);
  w.db.prepare("INSERT INTO contacts (msisdn, number, name, at) VALUES (?, ?, ?, ?) ON CONFLICT (msisdn, number) DO UPDATE SET name = excluded.name").run(phone.msisdn, number, name, w.now);
  return { number, name };
}

export function removeContact(w: World, msisdn: string, number: string) {
  w.db.prepare("DELETE FROM contacts WHERE msisdn = ? AND number = ?").run(normalizeMsisdn(msisdn), normalizeMsisdn(number));
}
