import type { Fee } from "./config/schemas";
import { SimError, type Telco } from "./util";
import type { World } from "./world";

/** The shared books: wallets, bank accounts and the double-entry postings behind every movement of money. */

export interface WalletRow {
  id: string;
  msisdn: string;
  telco: Telco;
  person_id: string;
  owner_type: "person" | "agent" | "merchant";
  display_name: string;
  kyc_tier: "minimum" | "medium" | "enhanced";
  pin: string;
  pin_fails: number;
  status: "active" | "frozen" | "locked";
  balance: number;
  created_at: number;
}

export interface AccountRow {
  id: string;
  bank: string;
  account_no: string;
  person_id: string | null;
  name: string;
  kind: "personal" | "trust";
  telco: string | null;
  status: string;
  balance: number;
  created_at: number;
}

export interface TxnRow {
  id: string;
  type: string;
  channel: string;
  from_wallet: string | null;
  to_wallet: string | null;
  from_account: string | null;
  to_account: string | null;
  from_party: string | null;
  to_party: string | null;
  rail: string;
  amount: number;
  fee: number;
  commission: number;
  status: string;
  reason: string | null;
  reference: string | null;
  related: string | null;
  created_at: number;
}

export const getWallet = (w: World, id: string) => w.db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined;
export const walletByMsisdn = (w: World, msisdn: string) => w.db.prepare("SELECT * FROM wallets WHERE msisdn = ?").get(msisdn) as WalletRow | undefined;
export const getAccount = (w: World, id: string) => w.db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(id) as AccountRow | undefined;
export const accountByNumber = (w: World, n: string) => w.db.prepare("SELECT * FROM bank_accounts WHERE account_no = ?").get(String(n).trim()) as AccountRow | undefined;
export const getTxn = (w: World, id: string) => w.db.prepare("SELECT * FROM txns WHERE id = ?").get(id) as TxnRow | undefined;

export function feeFor(fee: Fee, amount: number): number {
  const c = amount / 100;
  const band = fee.bands.find((b) => b.upTo === null || c <= b.upTo) ?? fee.bands[fee.bands.length - 1];
  const f = band.flat * 100 + (amount * band.pct) / 100;
  return Math.round(band.max === undefined ? f : Math.min(f, band.max * 100));
}

/** Balance of any ledger account, from its postings. */
export function balanceOf(w: World, account: string): number {
  return Number((w.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM postings WHERE account = ?").get(account) as { n: number }).n);
}

/**
 * Writes balanced postings and applies them to wallet and bank balances.
 * Accounts: w:<wallet> and bank:<account> hold customers' money; fee:<party> is an institution's income;
 * emoney:<telco> is the e-money a telco has issued against its trust account; vault:<bank> is a bank's cash;
 * switch:<party> is what a participant owes (+) or is owed (-) until the next settlement; reserve:<bank> is
 * a bank's settlement account at the Bank of Ghana.
 */
export function post(w: World, txnId: string, entries: [string, number][]) {
  const sum = entries.reduce((s, [, a]) => s + a, 0);
  if (sum !== 0) throw new Error(`unbalanced postings for ${txnId}: ${sum}`);
  const ins = w.db.prepare("INSERT INTO postings(txn_id, account, amount, at) VALUES(?,?,?,?)");
  const updW = w.db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?");
  const updB = w.db.prepare("UPDATE bank_accounts SET balance = balance + ? WHERE id = ?");
  for (const [account, amount] of entries) {
    if (amount === 0) continue;
    ins.run(txnId, account, amount, w.now);
    if (account.startsWith("w:")) updW.run(amount, account.slice(2));
    else if (account.startsWith("bank:")) updB.run(amount, account.slice(5));
  }
}

export function insertTxn(w: World, t: Partial<TxnRow> & Pick<TxnRow, "id" | "type" | "channel" | "rail" | "amount" | "status">) {
  w.db
    .prepare(
      `INSERT INTO txns(id, type, channel, from_wallet, to_wallet, from_account, to_account, from_party, to_party, rail, amount, fee, commission, status, reason, reference, related, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      t.id, t.type, t.channel, t.from_wallet ?? null, t.to_wallet ?? null, t.from_account ?? null, t.to_account ?? null, t.from_party ?? null, t.to_party ?? null,
      t.rail, t.amount, t.fee ?? 0, t.commission ?? 0, t.status, t.reason ?? null, t.reference ?? null, t.related ?? null, w.now,
    );
}

/** Checks a wallet PIN, counting wrong attempts and locking the wallet when the telco's limit is reached. */
export function checkPin(w: World, wallet: WalletRow, pin: string | undefined, attemptsBeforeLock: number) {
  if (wallet.status === "locked") throw new SimError("Wallet is locked after too many wrong PINs. Visit a service centre to reset your PIN.");
  if (pin === wallet.pin) {
    if (wallet.pin_fails) w.db.prepare("UPDATE wallets SET pin_fails = 0 WHERE id = ?").run(wallet.id);
    return;
  }
  const fails = wallet.pin_fails + 1;
  if (fails >= attemptsBeforeLock) {
    w.db.prepare("UPDATE wallets SET pin_fails = ?, status = 'locked' WHERE id = ?").run(fails, wallet.id);
    throw new SimError("Wrong PIN. Your wallet is now locked. Visit a service centre to reset your PIN.");
  }
  w.db.prepare("UPDATE wallets SET pin_fails = ? WHERE id = ?").run(fails, wallet.id);
  throw new SimError(`Wrong PIN. ${attemptsBeforeLock - fails} attempt(s) left.`);
}
