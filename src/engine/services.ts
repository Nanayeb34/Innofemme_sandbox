import { getConfig } from "./config/store";
import { DEFAULT_ATM, DEFAULT_BILLERS, DEFAULT_BUNDLES } from "./catalogue";
import { checkPin, feeFor, getAccount, type WalletRow } from "./ledger";
import { sendSms } from "./notify";
import { bankToWallet, walletPay, walletSpend, type Receipt } from "./payments";
import { getSim } from "./telco";
import { BANK_IDS, MINUTE, SimError, TELCO_INFO, bankName, cedis, clock, digits, normalizeMsisdn, type Telco } from "./util";
import { audit, type World } from "./world";

/**
 * What a wallet can do besides sending money: withdraw at an agent or a cash machine, buy airtime
 * and data, pay bills, pull money in from the owner's bank account. Each is reached from the
 * network's phone menu.
 */

const cfgOf = (w: World, telco: Telco) => getConfig(w.db, `telco.${telco}`);
export const bundlesOf = (w: World, telco: Telco) => cfgOf(w, telco).bundles ?? DEFAULT_BUNDLES;
export const billersOf = (w: World, telco: Telco) => cfgOf(w, telco).billers ?? DEFAULT_BILLERS;
export const atmOf = (w: World, telco: Telco) => cfgOf(w, telco).atm ?? DEFAULT_ATM;
const sender = (telco: Telco) => TELCO_INFO[telco].wallet.replace(/\s/g, "");
const shortId = (id: string) => id.slice(3, 13).toUpperCase();

// ---------- agents ----------

export interface AgentLine {
  code: string;
  name: string;
  town: string;
  status: string;
  wallet_id: string;
  msisdn: string;
}
/** Finds one of this network's mobile money agents by agent number, or by the agent line's phone number. */
export function agentBy(w: World, telco: Telco, input: string): AgentLine | undefined {
  const value = String(input ?? "").trim();
  return w.db
    .prepare("SELECT a.code, a.name, a.town, a.status, a.wallet_id, x.msisdn FROM momo_agents a JOIN wallets x ON x.id = a.wallet_id WHERE x.telco = ? AND (a.code = ? OR x.msisdn = ?)")
    .get(telco, value, normalizeMsisdn(value)) as AgentLine | undefined;
}

/** What a customer sees when they check an agent before handing over cash or their phone. */
export function verifyAgent(w: World, telco: Telco, input: string): string {
  const a = agentBy(w, telco, input);
  const brand = TELCO_INFO[telco];
  if (!a) return `${input} is NOT a registered ${brand.wallet} agent. Do not give this person money or your PIN. Call ${brand.careLine} to report.`;
  if (a.status !== "active") return `Agent ${a.code} (${a.name}) is SUSPENDED and must not serve customers. Call ${brand.careLine} to report.`;
  return `Agent ${a.code}: ${a.name}, ${a.town}. Registered ${brand.wallet} agent, line ${a.msisdn}.`;
}

/** The customer starts a withdrawal on their own phone: the agent's number, the amount and their PIN. The agent then hands over the cash. */
export function withdrawAtAgent(w: World, from: WalletRow, o: { agent: string; amount: number; pin: string; acknowledged?: boolean }): Receipt {
  const a = agentBy(w, from.telco, o.agent);
  if (!a) throw new SimError(`${o.agent} is not a ${TELCO_INFO[from.telco].wallet} agent`);
  return walletPay(w, { type: "cashout", channel: "ussd", from: from.id, to: a.wallet_id, amount: o.amount, pin: o.pin, acknowledged: o.acknowledged });
}

// ---------- cash machines ----------

/** Whether a network's menu has a way to get a cash machine voucher: followed from the first screen, as a customer would. */
/**
 * How a customer gets to the requests waiting for their answer, in words: "choose 4 (Allow Cash Out)" on one
 * network, "choose 6 (My Wallet), then 4 (My Approvals)" on another. Read from the menu as it is now, so it
 * stays true when a team rearranges the menu. The shortest way is given.
 */
export function approvalsPath(w: World, telco: Telco): string {
  const menu = cfgOf(w, telco).menu;
  const seen = new Set<string>([menu.start]);
  let level: { id: string; steps: string[] }[] = [{ id: menu.start, steps: [] }];
  while (level.length) {
    const next: typeof level = [];
    const found: string[][] = [];
    for (const { id, steps } of level) {
      const node = menu.nodes[id];
      if (!node || node.type !== "menu") continue;
      for (const o of node.options) {
        const to = menu.nodes[o.next];
        const path = [...steps, `${o.key} (${o.label})`];
        if (to?.type === "action" && to.action === "approvals") found.push(path);
        else if (!seen.has(o.next)) {
          seen.add(o.next);
          next.push({ id: o.next, steps: path });
        }
      }
    }
    // Where a menu offers two equally short ways, the one named for approvals in general is the one to send people to.
    if (found.length) return `choose ${(found.find((p) => /approvals/i.test(p[p.length - 1])) ?? found[0]).join(", then ")}`;
    level = next;
  }
  return "open the requests waiting for approval";
}

export function offersAtm(w: World, telco: Telco): boolean {
  const menu = cfgOf(w, telco).menu;
  const seen = new Set<string>();
  const queue = [menu.start];
  while (queue.length) {
    const id = queue.pop()!;
    const node = menu.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);
    if (node.type === "action" && node.action === "atm_voucher") return true;
    if (node.type === "menu") queue.push(...node.options.map((o) => o.next));
    if (node.type === "input" || node.type === "warning" || node.type === "set") queue.push(node.next);
    if (node.type === "branch") queue.push(node.then, node.else);
  }
  return false;
}

/**
 * Cardless withdrawal, step one: the customer asks for a voucher from their phone. Nothing leaves the
 * wallet yet. The voucher is used at a partner bank's cash machine before it runs out.
 */
export function atmVoucher(w: World, from: WalletRow, o: { amount: number; pin: string; acknowledged?: boolean }): string {
  const atm = atmOf(w, from.telco);
  if (o.amount % 1000) throw new SimError("Cash machines pay out in multiples of GHS 10");
  const fee = feeFor(cfgOf(w, from.telco).fees.cashout, o.amount);
  walletSpend(w, { type: "atm_withdrawal", channel: "ussd", from: from.id, amount: o.amount, fee, pin: o.pin, toParty: atm.banks[0], payee: { kind: "cash_machine", banks: atm.banks }, payeeKey: "atm", entries: [], acknowledged: o.acknowledged, checkOnly: true });
  w.db.prepare("UPDATE atm_vouchers SET status = 'expired' WHERE msisdn = ? AND status = 'active'").run(from.msisdn);
  let code = "";
  do code = digits(6);
  while (w.db.prepare("SELECT 1 FROM atm_vouchers WHERE code = ?").get(code));
  const expires = w.now + atm.minutes * MINUTE;
  w.db.prepare("INSERT INTO atm_vouchers(code, msisdn, wallet_id, telco, amount, status, created_at, expires_at) VALUES(?,?,?,?,?, 'active', ?, ?)").run(code, from.msisdn, from.id, from.telco, o.amount, w.now, expires);
  const where = atm.banks.map(bankName).join(" or ");
  sendSms(w, from.msisdn, sender(from.telco), `Your cash machine voucher is ${code} for GHS ${cedis(o.amount)}. Fee GHS ${cedis(fee)}. Use it at any ${where} cash machine before ${clock(expires).slice(6)}. Do not share it.`);
  return `Voucher ${code} for GHS ${cedis(o.amount)}. Fee GHS ${cedis(fee)}. Use it at any ${where} cash machine (Cardless withdrawal) within ${atm.minutes} minutes.`;
}

/** Cardless withdrawal, step two: at the bank's cash machine, the phone number and the voucher. The money leaves the wallet and the machine pays out. */
export function atmWithdraw(w: World, bank: string, o: { msisdn?: string; code?: string }): Receipt {
  if (!BANK_IDS.includes(bank)) throw new SimError("Unknown bank");
  const msisdn = normalizeMsisdn(String(o.msisdn ?? ""));
  w.db.prepare("UPDATE atm_vouchers SET status = 'expired' WHERE status = 'active' AND expires_at < ?").run(w.now);
  const v = w.db.prepare("SELECT * FROM atm_vouchers WHERE code = ? AND msisdn = ?").get(String(o.code ?? "").trim(), msisdn) as { code: string; wallet_id: string; telco: Telco; amount: number; status: string } | undefined;
  if (!v) throw new SimError("The phone number and voucher do not match");
  if (v.status === "used") throw new SimError("This voucher has already been used");
  if (v.status !== "active") throw new SimError("This voucher has expired. Get a new one from your phone.");
  if (!atmOf(w, v.telco).banks.includes(bank)) throw new SimError(`${TELCO_INFO[v.telco].wallet} vouchers work at ${atmOf(w, v.telco).banks.map(bankName).join(" and ")} cash machines`);
  const fee = feeFor(cfgOf(w, v.telco).fees.cashout, v.amount);
  const r = walletSpend(w, {
    type: "atm_withdrawal", channel: "atm", from: v.wallet_id, amount: v.amount, fee, toParty: bank, payee: { kind: "cash_machine", bank }, payeeKey: "atm", authorised: true, reference: `Cash machine, ${bankName(bank)}`,
    entries: [[`vault:${bank}`, v.amount]],
    then: (id) => {
      w.db.prepare("UPDATE atm_vouchers SET status = 'used', bank = ?, txn_id = ? WHERE code = ?").run(bank, id, v.code);
      audit(w, bank, "atm", `Cash machine paid GHS ${cedis(v.amount)} against a ${TELCO_INFO[v.telco].wallet} voucher for ${msisdn}`);
    },
  });
  sendSms(w, msisdn, sender(v.telco), `You withdrew GHS ${cedis(v.amount)} at a ${bankName(bank)} cash machine. Fee GHS ${cedis(fee)}. Balance: GHS ${cedis(r.balance)}. Trans ID: ${shortId(r.txnId)}`);
  return { txnId: r.txnId, fee, commission: 0, message: `Take your cash: GHS ${cedis(v.amount)}.` };
}

// ---------- airtime and data ----------

export function lineBalance(w: World, msisdn: string) {
  const b = w.db.prepare("SELECT airtime, data_mb, data_expires FROM sim_balances WHERE msisdn = ?").get(msisdn) as { airtime: number; data_mb: number; data_expires: number | null } | undefined;
  const live = !!b?.data_expires && b.data_expires > w.now;
  return { airtime: b?.airtime ?? 0, dataMb: live ? b!.data_mb : 0, dataExpires: live ? b!.data_expires : null };
}
export function lineBalanceText(w: World, msisdn: string) {
  const b = lineBalance(w, msisdn);
  return `Airtime: GHS ${cedis(b.airtime)}\nData: ${b.dataMb ? `${b.dataMb}MB, until ${clock(b.dataExpires!).slice(0, 5)}` : "none"}`;
}
/** The line being topped up: the buyer's own, or another number on the same network. */
function topUpLine(w: World, from: WalletRow, to?: string) {
  const msisdn = to ? normalizeMsisdn(to) : from.msisdn;
  const sim = getSim(w, msisdn);
  if (!sim || sim.status !== "active" || sim.telco !== from.telco) throw new SimError(`Enter an active ${TELCO_INFO[from.telco].name} number`);
  return msisdn;
}
const credit = (w: World, msisdn: string, airtime: number, mb = 0, until: number | null = null) => {
  const b = lineBalance(w, msisdn);
  w.db
    .prepare("INSERT INTO sim_balances(msisdn, airtime, data_mb, data_expires) VALUES(?,?,?,?) ON CONFLICT(msisdn) DO UPDATE SET airtime = excluded.airtime, data_mb = excluded.data_mb, data_expires = excluded.data_expires")
    .run(msisdn, b.airtime + airtime, b.dataMb + mb, mb ? Math.max(until ?? 0, b.dataExpires ?? 0) : b.dataExpires);
};

export function buyAirtime(w: World, from: WalletRow, o: { to?: string; amount: number; pin: string; acknowledged?: boolean }): Receipt {
  const to = topUpLine(w, from, o.to);
  const own = to === from.msisdn;
  const r = walletSpend(w, {
    type: "airtime", channel: "ussd", from: from.id, amount: o.amount, fee: 0, pin: o.pin, toParty: from.telco, payee: { kind: "airtime", number: to, ownNumber: own }, payeeKey: `airtime:${to}`,
    entries: [[`airtime:${from.telco}`, o.amount]], reference: `Airtime for ${to}`, acknowledged: o.acknowledged,
    then: () => credit(w, to, o.amount),
  });
  if (!own) sendSms(w, to, TELCO_INFO[from.telco].name, `You have received GHS ${cedis(o.amount)} airtime from ${from.msisdn}.`);
  sendSms(w, from.msisdn, sender(from.telco), `You bought GHS ${cedis(o.amount)} airtime for ${own ? "your number" : to}. Balance: GHS ${cedis(r.balance)}. Trans ID: ${shortId(r.txnId)}`);
  return { txnId: r.txnId, fee: 0, commission: 0, message: `GHS ${cedis(o.amount)} airtime bought for ${own ? "your number" : to}. Trans ID ${shortId(r.txnId)}.` };
}

export function buyBundle(w: World, from: WalletRow, o: { bundle: string; to?: string; pin: string; acknowledged?: boolean }): Receipt {
  const b = bundlesOf(w, from.telco).find((x) => x.id === o.bundle);
  if (!b) throw new SimError("That bundle is not on offer");
  const to = topUpLine(w, from, o.to);
  const own = to === from.msisdn;
  const amount = Math.round(b.price * 100);
  const r = walletSpend(w, {
    type: "airtime", channel: "ussd", from: from.id, amount, fee: 0, pin: o.pin, toParty: from.telco, payee: { kind: "data_bundle", bundle: b.name, number: to, ownNumber: own }, payeeKey: `airtime:${to}`,
    entries: [[`airtime:${from.telco}`, amount]], reference: `${b.name} for ${to}`, acknowledged: o.acknowledged,
    then: () => credit(w, to, 0, b.mb, w.now + b.days * 24 * 60 * MINUTE),
  });
  if (!own) sendSms(w, to, TELCO_INFO[from.telco].name, `You have received a ${b.name} data bundle from ${from.msisdn}.`);
  sendSms(w, from.msisdn, sender(from.telco), `You bought ${b.name} for ${own ? "your number" : to} at GHS ${cedis(amount)}. Balance: GHS ${cedis(r.balance)}. Trans ID: ${shortId(r.txnId)}`);
  return { txnId: r.txnId, fee: 0, commission: 0, message: `${b.name} bought for ${own ? "your number" : to}. GHS ${cedis(amount)}. Trans ID ${shortId(r.txnId)}.` };
}

// ---------- bills ----------

export function payBill(w: World, from: WalletRow, o: { biller: string; ref: string; amount: number; pin: string; acknowledged?: boolean }): Receipt {
  const b = billersOf(w, from.telco).find((x) => x.id === o.biller);
  if (!b) throw new SimError("That biller is not on offer");
  const ref = String(o.ref ?? "").trim();
  if (!/^[A-Za-z0-9-]{4,20}$/.test(ref)) throw new SimError("That account number is not valid");
  const fee = feeFor(cfgOf(w, from.telco).fees.merchant, o.amount);
  const token = b.token ? digits(20).replace(/(\d{4})(?=\d)/g, "$1-") : null;
  const r = walletSpend(w, {
    type: "bill", channel: "ussd", from: from.id, amount: o.amount, fee, pin: o.pin, toParty: from.telco, payee: { kind: "bill", biller: b.name, account: ref }, payeeKey: `bill:${b.id}:${ref}`,
    entries: [[`billers:${from.telco}`, o.amount]], reference: `${b.name} ${ref}`, acknowledged: o.acknowledged,
    then: (id) => w.db.prepare("INSERT INTO bill_payments(txn_id, at, telco, biller, account_ref, amount, token, msisdn) VALUES(?,?,?,?,?,?,?,?)").run(id, w.now, from.telco, b.name, ref, o.amount, token, from.msisdn),
  });
  sendSms(w, from.msisdn, sender(from.telco), `You paid GHS ${cedis(o.amount)} to ${b.name} for ${ref}.${token ? ` Token: ${token}.` : ""} Fee GHS ${cedis(fee)}. Balance: GHS ${cedis(r.balance)}. Trans ID: ${shortId(r.txnId)}`);
  return { txnId: r.txnId, fee, commission: 0, message: `GHS ${cedis(o.amount)} paid to ${b.name} for ${ref}.${token ? ` Token: ${token}` : ""} Trans ID ${shortId(r.txnId)}.` };
}

// ---------- bank to wallet ----------

/** The bank account held by the wallet's owner, if they have one: the account "linked" to the wallet. */
export function ownAccount(w: World, wallet: WalletRow) {
  const row = w.db.prepare("SELECT id FROM bank_accounts WHERE person_id = ? AND kind = 'personal' AND status = 'active' ORDER BY created_at LIMIT 1").get(wallet.person_id) as { id: string } | undefined;
  return row ? getAccount(w, row.id) : undefined;
}
export function fromOwnBank(w: World, wallet: WalletRow, o: { amount: number; pin: string }): Receipt {
  checkPin(w, wallet, o.pin, cfgOf(w, wallet.telco).pinAttemptsBeforeLock);
  const a = ownAccount(w, wallet);
  if (!a) throw new SimError("No bank account is linked to your wallet. Open one with your Ghana Card at a bank.");
  return bankToWallet(w, { bank: a.bank, fromAccount: a.id, msisdn: wallet.msisdn, amount: o.amount, reference: "Bank to wallet" });
}
