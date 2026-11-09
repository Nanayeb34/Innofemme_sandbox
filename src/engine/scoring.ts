import type { World } from "./world";
import { DAY } from "./util";

export interface Metrics {
  from: number;
  to: number;
  legitTxns: number;
  legitValue: number;
  fraudAttempts: number;
  fraudValue: number;
  fraudPrevented: number;
  fraudPreventedValue: number;
  fraudMissed: number;
  losses: number;
  launderingHops: number; // proceeds moving between mules (is_fraud = 2)
  launderingStopped: number;
  falsePositives: number; // genuine payments blocked, abandoned or reversed
  legitHeld: number;
  legitWarned: number;
  legitSecondFactor: number;
  detectionRate: number; // share of fraud attempts stopped
  lossPreventionRate: number; // share of fraud value stopped
  falsePositiveRate: number;
  frictionPer1000: number; // extra steps (warnings, holds, codes) per 1000 genuine payments
  score: number;
}

const PREVENTED = "('blocked','abandoned','reversed')";

export function metrics(w: World, from = 0, to = Number.MAX_SAFE_INTEGER): Metrics {
  const q = (sql: string) => w.db.prepare(sql).get(from, to) as Record<string, number>;
  // Money injected by the bots themselves (bank transfers seeding mule wallets) is not a victim payment.
  const scope = "created_at >= ? AND created_at < ? AND type NOT IN ('cashin','from_bank')";
  const f = q(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v,
      SUM(status IN ${PREVENTED}) AS prevented, COALESCE(SUM(CASE WHEN status IN ${PREVENTED} THEN amount END),0) AS prevented_v,
      SUM(status IN ('success','held')) AS missed, COALESCE(SUM(CASE WHEN status IN ('success','held') THEN amount END),0) AS losses
    FROM txns WHERE ${scope} AND is_fraud = 1`);
  const m = q(`SELECT COUNT(*) AS n, SUM(status IN ${PREVENTED}) AS stopped FROM txns WHERE created_at >= ? AND created_at < ? AND is_fraud = 2 AND type != 'from_bank'`);
  const l = q(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v,
      SUM(status IN ${PREVENTED}) AS fp, SUM(status IN ('held','reversed') OR release_at IS NOT NULL) AS held,
      SUM(warned) AS warned, SUM(second_factor) AS sf
    FROM txns WHERE ${scope} AND is_fraud = 0 AND status != 'failed'`);

  const fraudAttempts = f.n ?? 0;
  const legitTxns = l.n ?? 0;
  const detectionRate = fraudAttempts ? (f.prevented ?? 0) / fraudAttempts : 0;
  const lossPreventionRate = f.v ? (f.prevented_v ?? 0) / f.v : 0;
  const falsePositiveRate = legitTxns ? (l.fp ?? 0) / legitTxns : 0;
  const frictionPer1000 = legitTxns ? (((l.held ?? 0) + (l.warned ?? 0) + (l.sf ?? 0)) / legitTxns) * 1000 : 0;

  // Provisional composite: reward stopping fraud value, penalise blocking genuine users and adding friction.
  const launderingRate = m.n ? (m.stopped ?? 0) / m.n : 0;
  const score = Math.max(0, Math.round(100 * (0.5 * lossPreventionRate + 0.3 * detectionRate + 0.2 * launderingRate) - 300 * falsePositiveRate - 0.1 * frictionPer1000));

  return {
    from,
    to,
    legitTxns,
    legitValue: l.v ?? 0,
    fraudAttempts,
    fraudValue: f.v ?? 0,
    fraudPrevented: f.prevented ?? 0,
    fraudPreventedValue: f.prevented_v ?? 0,
    fraudMissed: f.missed ?? 0,
    losses: f.losses ?? 0,
    launderingHops: m.n ?? 0,
    launderingStopped: m.stopped ?? 0,
    falsePositives: l.fp ?? 0,
    legitHeld: l.held ?? 0,
    legitWarned: l.warned ?? 0,
    legitSecondFactor: l.sf ?? 0,
    detectionRate,
    lossPreventionRate,
    falsePositiveRate,
    frictionPer1000,
    score,
  };
}

export interface ChangeImpact {
  id: number;
  surface: string;
  summary: string;
  author: string;
  atSim: number;
  undone: boolean;
  before: Metrics;
  after: Metrics;
}

/** For each change: the 24 simulated hours before it vs. the period it was live. */
export function changeImpacts(w: World, limit = 20): ChangeImpact[] {
  const rows = w.db.prepare("SELECT id, surface, summary, author, at_sim, undone_by FROM config_history ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number;
    surface: string;
    summary: string;
    author: string;
    at_sim: number;
    undone_by: number | null;
  }[];
  return rows.map((r, i) => {
    const next = i > 0 ? rows[i - 1].at_sim : w.now;
    return {
      id: r.id,
      surface: r.surface,
      summary: r.summary,
      author: r.author,
      atSim: r.at_sim,
      undone: !!r.undone_by,
      before: metrics(w, r.at_sim - DAY, r.at_sim),
      after: metrics(w, r.at_sim, Math.max(next, r.at_sim + 1)),
    };
  });
}
