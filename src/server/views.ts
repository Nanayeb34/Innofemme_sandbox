import { getMeta } from "@/engine/db";
import { populationCache } from "@/engine/sim";
import { metrics } from "@/engine/scoring";
import { PERSONAS } from "@/engine/population";
import { isRunning, speedOf } from "@/engine/worlds";
import type { World } from "@/engine/world";
import { DAY, TELCO_INFO, telcoOf } from "@/engine/util";
import { getConfig } from "@/engine/config/store";
import { telcoLogo } from "./logos";

/** Transactions as teams see them: no ground-truth labels. */
export function feed(w: World, opts: { limit?: number; before?: number; wallet?: string; status?: string } = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.before) {
    where.push("t.created_at < ?");
    args.push(opts.before);
  }
  if (opts.wallet) {
    where.push("(t.from_wallet = ? OR t.to_wallet = ?)");
    args.push(opts.wallet, opts.wallet);
  }
  if (opts.status) {
    where.push("t.status = ?");
    args.push(opts.status);
  }
  const sql = `SELECT t.id, t.created_at, t.type, t.channel, t.rail, t.amount, t.fee, t.status, t.reason, t.warned, t.second_factor, t.checks, t.reference, t.release_at,
      fw.msisdn AS from_msisdn, fw.display_name AS from_name, fw.telco AS from_telco,
      tw.msisdn AS to_msisdn, tw.display_name AS to_name, tw.telco AS to_telco,
      b.bank AS bank, b.name AS bank_name
    FROM txns t
    LEFT JOIN wallets fw ON fw.id = t.from_wallet
    LEFT JOIN wallets tw ON tw.id = t.to_wallet
    LEFT JOIN bank_accounts b ON b.id = t.bank_account
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`;
  args.push(Math.min(opts.limit ?? 50, 500));
  return (w.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
    id: r.id,
    at: new Date(r.created_at as number).toISOString(),
    type: r.type,
    channel: r.channel,
    rail: r.rail,
    amount: (r.amount as number) / 100,
    fee: (r.fee as number) / 100,
    status: r.status,
    reason: r.reason,
    warned: !!r.warned,
    secondFactor: !!r.second_factor,
    checks: r.checks ? JSON.parse(r.checks as string) : [],
    reference: r.reference,
    releaseAt: r.release_at ? new Date(r.release_at as number).toISOString() : null,
    from: r.from_msisdn ? { msisdn: r.from_msisdn, name: r.from_name, telco: r.from_telco } : r.bank ? { bank: r.bank, name: r.bank_name } : null,
    to: r.to_msisdn ? { msisdn: r.to_msisdn, name: r.to_name, telco: r.to_telco } : r.bank ? { bank: r.bank, name: r.bank_name } : null,
  }));
}

export function personas(w: World) {
  const numbers = JSON.parse(getMeta(w.db, "personas") ?? "{}") as Record<string, string>;
  return PERSONAS.map((p) => ({ ...p, msisdn: numbers[p.key] }));
}

export function worldState(w: World) {
  const counts = w.db.prepare("SELECT status, COUNT(*) AS n FROM txns WHERE created_at > ? GROUP BY status").all(w.now - DAY) as { status: string; n: number }[];
  return {
    world: w.id,
    simTime: new Date(w.now).toISOString(),
    running: isRunning(w),
    speed: speedOf(w),
    last24h: metrics(w, w.now - DAY, w.now + 1),
    overall: metrics(w),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    reports: (w.db.prepare("SELECT COUNT(*) AS n FROM fraud_reports").get() as { n: number }).n,
    pendingProposals: (w.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").get() as { n: number }).n,
  };
}

export function phoneState(w: World, msisdn: string) {
  const wallet = w.db.prepare("SELECT id, msisdn, telco, display_name, kyc_tier, status, balance FROM wallets WHERE msisdn = ?").get(msisdn) as
    | { id: string; msisdn: string; telco: keyof typeof TELCO_INFO; display_name: string; kyc_tier: string; status: string; balance: number }
    | undefined;
  if (!wallet) return null;
  const telco = telcoOf(msisdn) ?? wallet.telco;
  return {
    msisdn,
    name: wallet.display_name,
    telco,
    brand: TELCO_INFO[telco],
    logo: telcoLogo(telco),
    shortcode: getConfig(w.db, "menus")[telco].shortcode,
    kycTier: wallet.kyc_tier,
    status: wallet.status,
    balance: wallet.balance / 100,
    simTime: new Date(w.now).toISOString(),
    sms: (w.db.prepare("SELECT id, sender, body, at, read FROM sms WHERE msisdn = ? ORDER BY id DESC LIMIT 60").all(msisdn) as { id: number; sender: string; body: string; at: number; read: number }[]).map((s) => ({
      ...s,
      at: new Date(s.at).toISOString(),
    })),
    calls: (w.db.prepare("SELECT id, caller, caller_label, script, at FROM calls WHERE msisdn = ? ORDER BY id DESC LIMIT 20").all(msisdn) as { id: number; caller: string; caller_label: string; script: string; at: number }[]).map((c) => ({
      ...c,
      at: new Date(c.at).toISOString(),
    })),
    approvals: (w.db.prepare("SELECT r.ref, r.amount, r.payer_message, w.display_name FROM rtp r JOIN wallets w ON w.id = r.payee_wallet WHERE r.payer_msisdn = ? AND r.status = 'PENDING'").all(msisdn) as { ref: string; amount: number; payer_message: string; display_name: string }[]).map(
      (a) => ({ ...a, amount: a.amount / 100 }),
    ),
    recent: feed(w, { wallet: wallet.id, limit: 15 }),
  };
}

export function directory(w: World) {
  const c = populationCache(w);
  const pick = (ids: string[], n: number) =>
    (w.db.prepare(`SELECT msisdn, display_name, telco FROM wallets WHERE id IN (${ids.slice(0, n).map(() => "?").join(",")})`).all(...ids.slice(0, n)) as { msisdn: string; display_name: string; telco: string }[]);
  return {
    customers: pick(c.customers, 12),
    merchants: w.db.prepare("SELECT m.till, m.name, w.telco FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE m.fake = 0 LIMIT 12").all(),
    agents: w.db.prepare("SELECT a.code, a.name, w.telco, w.msisdn FROM agents a JOIN wallets w ON w.id = a.wallet_id WHERE a.colluding = 0 LIMIT 8").all(),
  };
}
