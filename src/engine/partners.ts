import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { accountByNumber, getAccount, getWallet, type AccountRow, type WalletRow } from "./ledger";
import { BANK_IDS, SimError, bankName, isTelco, need, participantName } from "./util";
import { audit, type World } from "./world";

/**
 * API partners: companies an institution has given programmatic access to, the way a telco, a bank,
 * GhIPSS or NIA signs up a licensed payment or messaging company. Each institution issues its own
 * credentials from its own console; a credential works only on that institution's API.
 */

export interface ApiClient {
  id: string;
  institution: string;
  name: string;
  secret: string;
  wallet_id: string | null;
  account_id: string | null;
  callback_url: string | null;
  status: "active" | "suspended";
  calls: number;
  last_used_at: number | null;
  created_at: number;
}

export const API_INSTITUTIONS = ["mtn", "telecel", "at", ...BANK_IDS, "switch", "nia"];
export const institutionName = (i: string) => (i === "switch" ? "National switch" : i === "nia" ? "NIA" : isTelco(i) ? participantName(i) : bankName(i));

export const getClient = (w: World, id: string) => w.db.prepare("SELECT * FROM api_clients WHERE id = ?").get(id) as ApiClient | undefined;

/**
 * An institution gives a company API access. A telco ties the partner to the merchant wallet it will
 * collect into and pay out from; a bank ties it to the account it will operate.
 */
export function createClient(w: World, institution: string, input: { name?: string; till?: string; accountNo?: string; callbackUrl?: string; id?: string }): ApiClient {
  if (!API_INSTITUTIONS.includes(institution)) throw new SimError("This institution does not issue API access");
  const name = String(need(input.name?.trim(), "Partner's name")).slice(0, 60);
  let wallet: WalletRow | undefined;
  let account: AccountRow | undefined;
  if (isTelco(institution) && input.till) {
    const m = w.db.prepare("SELECT m.wallet_id FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE m.till = ? AND w.telco = ?").get(String(input.till).trim(), institution) as { wallet_id: string } | undefined;
    if (!m) throw new SimError(`No merchant ${input.till} on this network. Onboard the partner as a merchant first.`);
    wallet = getWallet(w, m.wallet_id);
  }
  if (BANK_IDS.includes(institution)) {
    account = accountByNumber(w, String(need(input.accountNo, "The partner's account at this bank")));
    if (!account || account.bank !== institution || account.kind !== "personal") throw new SimError("That account is not held at this bank");
  }
  const callbackUrl = input.callbackUrl?.trim() || null;
  if (callbackUrl && !/^https?:\/\//.test(callbackUrl)) throw new SimError("The callback address must start with http:// or https://");
  const id = input.id ?? randomUUID();
  if (getClient(w, id)) throw new SimError("That client id is already in use");
  w.db
    .prepare("INSERT INTO api_clients(id, institution, name, secret, wallet_id, account_id, callback_url, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, institution, name, randomBytes(18).toString("base64url"), wallet?.id ?? null, account?.id ?? null, callbackUrl, w.now);
  audit(w, institution, "api_partner", `Gave API access to ${name}${wallet ? ` (merchant ${wallet.display_name})` : account ? ` (account ${account.account_no})` : ""}`);
  return getClient(w, id)!;
}

export function setClientStatus(w: World, institution: string, id: string, status: "active" | "suspended") {
  const c = getClient(w, id);
  if (!c || c.institution !== institution) throw new SimError("API partner not found");
  w.db.prepare("UPDATE api_clients SET status = ? WHERE id = ?").run(status, id);
  audit(w, institution, "api_partner", `API access for ${c.name} ${status === "active" ? "restored" : "suspended"}`);
}

/** Replaces a partner's key, for when it has leaked. The old key stops working at once. */
export function rotateSecret(w: World, institution: string, id: string): string {
  const c = getClient(w, id);
  if (!c || c.institution !== institution) throw new SimError("API partner not found");
  const secret = randomBytes(18).toString("base64url");
  w.db.prepare("UPDATE api_clients SET secret = ? WHERE id = ?").run(secret, id);
  audit(w, institution, "api_partner", `Issued a new API key to ${c.name}`);
  return secret;
}

/** Checks a client id and key against one institution. Returns undefined rather than saying which part was wrong. */
export function authenticate(w: World, institution: string, id: string | undefined, secret: string | undefined): ApiClient | undefined {
  if (!id || !secret) return undefined;
  const c = getClient(w, id);
  if (!c || c.institution !== institution || c.status !== "active") return undefined;
  const a = Buffer.from(secret);
  const b = Buffer.from(c.secret);
  return a.length === b.length && timingSafeEqual(a, b) ? c : undefined;
}

export function recordCall(w: World, clientId: string) {
  w.db.prepare("UPDATE api_clients SET calls = calls + 1, last_used_at = ? WHERE id = ?").run(w.now, clientId);
}

export function listClients(w: World, institution: string) {
  const rows = w.db.prepare("SELECT * FROM api_clients WHERE institution = ? ORDER BY created_at").all(institution) as unknown as ApiClient[];
  return rows.map((c) => {
    const wallet = c.wallet_id ? getWallet(w, c.wallet_id) : undefined;
    const account = c.account_id ? getAccount(w, c.account_id) : undefined;
    return {
      id: c.id, name: c.name, secret: c.secret, status: c.status, calls: c.calls, callbackUrl: c.callback_url,
      linked: wallet ? `${wallet.display_name} (${wallet.msisdn})` : account ? `${account.name} (${account.account_no})` : "",
      lastUsedAt: c.last_used_at ? new Date(c.last_used_at).toISOString() : null,
      createdAt: new Date(c.created_at).toISOString(),
    };
  });
}

/** The merchant wallet a telco partner acts for. Payment APIs need one. */
export function clientWallet(w: World, c: ApiClient): WalletRow {
  const wallet = c.wallet_id ? getWallet(w, c.wallet_id) : undefined;
  if (!wallet) throw new SimError("This partner has no merchant wallet. The network must link one before it can take or make payments.", 403);
  return wallet;
}

export function clientAccount(w: World, c: ApiClient): AccountRow {
  const a = c.account_id ? getAccount(w, c.account_id) : undefined;
  if (!a) throw new SimError("This partner has no account at this bank.", 403);
  return a;
}
