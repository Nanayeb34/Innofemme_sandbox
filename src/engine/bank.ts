import { BANKS, SimError, TELCOS, TELCO_INFO, TRUST_BANK, digits, newId } from "./util";
import { fullName, verify } from "./nia";
import { getAccount, type AccountRow } from "./ledger";
import { audit, type World } from "./world";

/** Bank accounts: customers' accounts opened against a Ghana Card, and the trust accounts that back each telco's e-money. */

function newAccountNo(w: World, bank: string): string {
  const sort = BANKS.find((b) => b.id === bank)!.sortCode;
  for (;;) {
    const n = sort + digits(10);
    if (!w.db.prepare("SELECT 1 FROM bank_accounts WHERE account_no = ?").get(n)) return n;
  }
}

export function openAccount(w: World, bank: string, input: { card?: string; fingerprint?: string }): AccountRow {
  const p = verify(w, { requester: bank, purpose: "Bank account opening", card: input.card, fingerprint: input.fingerprint, biometric: true });
  if (w.db.prepare("SELECT 1 FROM bank_accounts WHERE bank = ? AND person_id = ? AND kind = 'personal'").get(bank, p.id)) throw new SimError(`${fullName(p)} already has an account at this bank`);
  const id = newId("acct");
  const no = newAccountNo(w, bank);
  w.db.prepare("INSERT INTO bank_accounts(id, bank, account_no, person_id, name, kind, created_at) VALUES(?,?,?,?,?, 'personal', ?)").run(id, bank, no, p.id, fullName(p), w.now);
  audit(w, bank, "account_opened", `Opened account ${no} for ${fullName(p)} (${p.ghana_card})`);
  return getAccount(w, id)!;
}

export function setAccountStatus(w: World, bank: string, accountId: string, status: "active" | "frozen") {
  const a = getAccount(w, accountId);
  if (!a || a.bank !== bank || a.kind !== "personal") throw new SimError("Account not found at this bank");
  w.db.prepare("UPDATE bank_accounts SET status = ? WHERE id = ?").run(status, a.id);
  audit(w, bank, "account_status", `Account ${a.account_no} (${a.name}) set to ${status}`);
}

/** Creates the trust account that holds each telco's customer float. Part of setting up a new world. */
export function seedTrustAccounts(w: World) {
  for (const t of TELCOS) {
    const bank = TRUST_BANK[t];
    w.db
      .prepare("INSERT INTO bank_accounts(id, bank, account_no, person_id, name, kind, telco, created_at) VALUES(?,?,?,NULL,?, 'trust', ?, ?)")
      .run(`trust_${t}`, bank, newAccountNo(w, bank), `${TELCO_INFO[t].wallet} customer float (trust account)`, t, w.now);
  }
}
