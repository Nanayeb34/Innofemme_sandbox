import { randomInt } from "node:crypto";
import { REGIONS, SimError, code, digits, need, newId } from "./util";
import { audit, type World } from "./world";

/** National Identification Authority: issues Ghana Cards and answers identity checks from telcos and banks. */

export interface Person {
  id: string;
  ghana_card: string;
  surname: string;
  first_names: string;
  dob: string;
  gender: string;
  nationality: string;
  region: string;
  town: string;
  fingerprint: string;
  status: string;
  issued_at: number;
}

export const fullName = (p: Pick<Person, "first_names" | "surname">) => `${p.first_names} ${p.surname}`;

export function ageOf(p: Pick<Person, "dob">, now: number): number {
  const d = new Date(p.dob);
  const n = new Date(now);
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/** Accepts "GHA-123456789-0", "gha1234567890" and similar. */
export function normalizeCard(input: string): string {
  const s = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z]{3})(\d{9})(\d)$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(input ?? "").trim().toUpperCase();
}

export function enrol(w: World, input: { surname?: string; firstNames?: string; dob?: string; gender?: string; nationality?: string; region?: string; town?: string }): Person {
  const surname = need(input.surname?.trim(), "Surname");
  const firstNames = need(input.firstNames?.trim(), "First names");
  const dob = need(input.dob, "Date of birth");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)) || Date.parse(dob) > w.now) throw new SimError("Date of birth must be a real date in the past (YYYY-MM-DD)");
  const gender = input.gender === "M" ? "M" : input.gender === "F" ? "F" : undefined;
  if (!gender) throw new SimError("Sex must be F or M");
  const region = need(input.region, "Region");
  if (!(REGIONS as readonly string[]).includes(region)) throw new SimError("Unknown region");
  const town = need(input.town?.trim(), "Town");
  const nationality = input.nationality?.trim() || "Ghanaian";

  const dup = w.db.prepare("SELECT ghana_card FROM persons WHERE lower(surname) = lower(?) AND lower(first_names) = lower(?) AND dob = ?").get(surname, firstNames, dob) as { ghana_card: string } | undefined;
  if (dup) throw new SimError(`This person is already enrolled with Ghana Card ${dup.ghana_card}. One person, one card.`);

  let card = "";
  do card = `GHA-${randomInt(1, 10)}${digits(8)}-${randomInt(10)}`;
  while (w.db.prepare("SELECT 1 FROM persons WHERE ghana_card = ?").get(card));
  const p: Person = { id: newId("p"), ghana_card: card, surname, first_names: firstNames, dob, gender, nationality, region, town, fingerprint: `FP-${code(6)}`, status: "active", issued_at: w.now };
  w.db
    .prepare("INSERT INTO persons(id, ghana_card, surname, first_names, dob, gender, nationality, region, town, fingerprint, status, issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.id, p.ghana_card, p.surname, p.first_names, p.dob, p.gender, p.nationality, p.region, p.town, p.fingerprint, p.status, p.issued_at);
  audit(w, "nia", "enrol", `Issued Ghana Card ${card} to ${fullName(p)}`);
  return p;
}

export const personById = (w: World, id: string) => w.db.prepare("SELECT * FROM persons WHERE id = ?").get(id) as Person | undefined;

/**
 * The identity verification service. An institution presents a card number and, for
 * in-person checks, the holder's fingerprint. Every request is logged, pass or fail.
 */
export function verify(w: World, req: { requester: string; purpose: string; card?: string; fingerprint?: string; biometric: boolean }): Person {
  const card = normalizeCard(need(req.card, "Ghana Card number"));
  const p = w.db.prepare("SELECT * FROM persons WHERE ghana_card = ?").get(card) as Person | undefined;
  const result = !p
    ? "NOT_FOUND"
    : p.status !== "active"
      ? "CARD_SUSPENDED"
      : req.biometric && String(req.fingerprint ?? "").trim().toUpperCase() !== p.fingerprint
        ? "BIOMETRIC_MISMATCH"
        : "MATCH";
  w.db.prepare("INSERT INTO nia_log(at, requester, purpose, ghana_card, biometric, result) VALUES(?,?,?,?,?,?)").run(w.now, req.requester, req.purpose, card, req.biometric ? 1 : 0, result);
  if (result === "NOT_FOUND") throw new SimError(`NIA: no Ghana Card ${card} on the national register`);
  if (result === "CARD_SUSPENDED") throw new SimError(`NIA: Ghana Card ${card} is suspended`);
  if (result === "BIOMETRIC_MISMATCH") throw new SimError("NIA: the fingerprint does not match the card holder");
  return p!;
}

export function setCardStatus(w: World, card: string, status: "active" | "suspended") {
  const c = normalizeCard(card);
  const r = w.db.prepare("UPDATE persons SET status = ? WHERE ghana_card = ?").run(status, c);
  if (!r.changes) throw new SimError("Ghana Card not found");
  audit(w, "nia", "card_status", `Ghana Card ${c} set to ${status}`);
}
