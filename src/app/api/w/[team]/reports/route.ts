import { authWorld, handle } from "@/server/http";

/** Fraud reports filed by customers: the delayed, partial labels a real telco would have. */
export const GET = handle(async (req, ctx: RouteContext<"/api/w/[team]/reports">) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const rows = w.db
    .prepare(
      `SELECT r.id, r.txn_id, r.reporter_msisdn, r.at, t.amount, t.status, t.created_at, tw.msisdn AS to_msisdn
       FROM fraud_reports r JOIN txns t ON t.id = r.txn_id LEFT JOIN wallets tw ON tw.id = t.to_wallet ORDER BY r.id DESC LIMIT 500`,
    )
    .all() as { id: number; txn_id: string; reporter_msisdn: string; at: number; amount: number; status: string; created_at: number; to_msisdn: string }[];
  return {
    reports: rows.map((r) => ({
      id: r.id,
      txnId: r.txn_id,
      reporter: r.reporter_msisdn,
      reportedAt: new Date(r.at).toISOString(),
      txnAt: new Date(r.created_at).toISOString(),
      amount: r.amount / 100,
      txnStatus: r.status,
      recipient: r.to_msisdn,
    })),
  };
});
