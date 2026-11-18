import { getConfig } from "./config/store";
import { tx } from "./db";
import { balanceOf, getAccount, insertTxn, post } from "./ledger";
import { BANK_IDS, PARTICIPANTS, SimError, TELCOS, cedis, isTelco, newId, participantName } from "./util";
import { audit, type World } from "./world";

/**
 * The national switch (GhIPSS in real life): routes payments between institutions,
 * keeps each participant's running position, and settles the net amounts.
 */

export function switchLog(w: World, txnId: string | null, step: string, from: string | null, to: string | null, detail: string) {
  w.db.prepare("INSERT INTO switch_log(txn_id, step, from_party, to_party, detail, at) VALUES(?,?,?,?,?,?)").run(txnId, step, from, to, detail, w.now);
}

/** Steps 1 and 2 of a routed payment: find the destination, check both ends are reachable, and quote. Throws if it cannot be routed. */
export function route(w: World, txnId: string, from: string, to: string, amount: number, target: string) {
  const cfg = getConfig(w.db, "switch");
  switchLog(w, txnId, "lookup", from, to, `${target} → ${participantName(to)}`);
  const reject = (why: string): never => {
    switchLog(w, txnId, "reject", from, to, why);
    throw new SimError(why);
  };
  if (!cfg.participants[from]?.connected) reject(`${participantName(from)} is disconnected from the national switch`);
  if (!cfg.participants[to]?.connected) reject(`${participantName(to)} is disconnected from the national switch`);
  if (amount > cfg.maxAmount * 100) reject(`Amount is above the switch limit of GHS ${cfg.maxAmount} per transaction`);
  switchLog(w, txnId, "quote", from, to, `amount ${cedis(amount)}; switch fee ${cfg.feePerTxn.toFixed(2)} billed to ${participantName(from)}`);
}

/** Step 3: the payment is final. The sender now owes the receiver through the switch until settlement. */
export function commit(w: World, txnId: string, from: string, to: string, amount: number) {
  switchLog(w, txnId, "commit", from, to, `${cedis(amount)} cleared; ${participantName(from)} owes ${participantName(to)}`);
}

/** Ledger entries that move `amount` from one participant's position to another's. */
export const positionEntries = (from: string, to: string, amount: number): [string, number][] => [
  [`switch:${from}`, amount],
  [`switch:${to}`, -amount],
];

export interface Position {
  participant: string;
  name: string;
  kind: "telco" | "bank";
  connected: boolean;
  /** Positive: owes the other participants. Negative: is owed. */
  position: number;
  sent: number;
  received: number;
  feesBilled: number;
}

export function positions(w: World): Position[] {
  const cfg = getConfig(w.db, "switch");
  return PARTICIPANTS.map((p) => {
    const vol = w.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN from_party = ? THEN 1 END),0) AS sent, COALESCE(SUM(CASE WHEN to_party = ? THEN 1 END),0) AS received
         FROM txns WHERE rail = 'switch' AND status IN ('success','reversed') AND type != 'reversal'`,
      )
      .get(p, p) as { sent: number; received: number };
    return {
      participant: p,
      name: participantName(p),
      kind: isTelco(p) ? ("telco" as const) : ("bank" as const),
      connected: !!cfg.participants[p]?.connected,
      position: balanceOf(w, `switch:${p}`),
      sent: vol.sent,
      received: vol.received,
      feesBilled: Math.round(vol.sent * cfg.feePerTxn * 100),
    };
  });
}

export function trustAccount(w: World, telco: string) {
  const row = w.db.prepare("SELECT id FROM bank_accounts WHERE kind = 'trust' AND telco = ?").get(telco) as { id: string } | undefined;
  return row ? getAccount(w, row.id)! : undefined;
}

/**
 * Net settlement. Each telco's position is settled through its trust account at its partner bank,
 * which takes the obligation on; then the banks settle among themselves across their accounts at the Bank of Ghana.
 */
export function settle(w: World): { id: string; lines: { participant: string; name: string; net: number }[] } {
  const before = positions(w).filter((p) => p.position !== 0);
  if (!before.length) throw new SimError("Nothing to settle: every participant's position is zero.");
  const id = newId("stl");
  const entries: [string, number][] = [];
  const bankNet: Record<string, number> = Object.fromEntries(BANK_IDS.map((b) => [b, balanceOf(w, `switch:${b}`)]));

  for (const t of TELCOS) {
    const p = balanceOf(w, `switch:${t}`);
    if (p === 0) continue;
    const trust = trustAccount(w, t);
    if (!trust) throw new Error(`no trust account for ${t}`);
    // Positive p: the telco pays out of its trust account and that much e-money stops existing. Negative: the reverse.
    entries.push([`switch:${t}`, -p], [`emoney:${t}`, p], [`bank:${trust.id}`, -p], [`switch:${trust.bank}`, p]);
    bankNet[trust.bank] += p;
  }
  for (const b of BANK_IDS) {
    if (bankNet[b] === 0) continue;
    entries.push([`switch:${b}`, -bankNet[b]], [`reserve:${b}`, bankNet[b]]);
  }

  const lines = before.map((p) => ({ participant: p.participant, name: p.name, net: p.position }));
  tx(w.db, () => {
    insertTxn(w, { id, type: "settlement", channel: "system", rail: "switch", amount: lines.filter((l) => l.net > 0).reduce((s, l) => s + l.net, 0), status: "success", reference: "Net settlement" });
    post(w, id, entries);
    w.db.prepare("INSERT INTO settlements(id, at, detail) VALUES(?,?,?)").run(id, w.now, JSON.stringify(lines));
    switchLog(w, id, "settlement", null, null, lines.map((l) => `${l.name} ${l.net > 0 ? "pays" : "receives"} ${cedis(Math.abs(l.net))}`).join("; "));
    audit(w, "switch", "settlement", `Net settlement ${id}: ${lines.length} participant(s) settled`);
  });
  return { id, lines };
}
