import { HttpError, body, handle } from "@/server/http";
import { issueToken, requirePartner } from "@/server/partner-auth";
import { accountByNumber, getTxn } from "@/engine/ledger";
import { clientAccount } from "@/engine/partners";
import { bankToWallet, bankTransfer } from "@/engine/payments";
import { switchLog } from "@/engine/switch";
import { locked } from "@/engine/integrations";
import { BANK_IDS, amountOf, bankName, need, normalizeMsisdn } from "@/engine/util";

/**
 * The bank partner API: what a bank gives a business customer to run its own account from software.
 * Base URL: /api/w/{team}/bank/{gcb|ecobank|fidelity|calbank|absa|stanbic}
 *   POST token                      client id + API key (Basic) → bearer token
 *   GET  v1/account                 the partner's account and balance
 *   GET  v1/account/transactions    statement, newest first
 *   POST v1/name-enquiry            { accountNumber } → the name on an account at any bank
 *   POST v1/transfers               { toAccountNumber, amount, narration } → to any bank account
 *   POST v1/wallet-transfers        { msisdn, amount, narration } → to a mobile money wallet
 *   GET  v1/transfers/{id}          the status of a transfer
 */

type Ctx = RouteContext<"/api/w/[team]/bank/[bank]/[...path]">;

async function setup(ctx: Ctx) {
  const { team, bank, path } = await ctx.params;
  if (!BANK_IDS.includes(bank)) throw new HttpError(404, `Unknown bank. Use one of: ${BANK_IDS.join(", ")}`);
  return { team, bank, path: path.join("/").replace(/\/$/, "") };
}

const statusOf = (id: string, fee: number) => ({ transactionId: id, status: "SUCCESSFUL", fee: fee / 100, currency: "GHS" });

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, bank, path } = await setup(ctx);
  if (path === "token") return issueToken(req, team, bank);
  const { w, client } = requirePartner(req, team, bank);
  const b = await body(req);
  return locked(w, () => {
    const account = clientAccount(w, client);
    switch (path) {
      case "v1/name-enquiry": {
        const a = accountByNumber(w, String(need(b.accountNumber as string, "accountNumber")));
        if (!a || a.kind !== "personal") throw new HttpError(404, "Account not found");
        // An account at another bank is looked up through the national switch.
        if (a.bank !== bank) switchLog(w, null, "lookup", bank, a.bank, `name enquiry for account ${a.account_no} by ${client.name}`);
        return { accountNumber: a.account_no, accountName: a.name, bankCode: a.bank, bankName: bankName(a.bank), status: a.status };
      }
      case "v1/transfers": {
        const r = bankTransfer(w, { bank, fromAccount: account.id, toAccountNo: String(need(b.toAccountNumber as string, "toAccountNumber")), amount: amountOf(b.amount), reference: (b.narration as string) ?? undefined });
        return statusOf(r.txnId, r.fee);
      }
      case "v1/wallet-transfers": {
        const r = bankToWallet(w, { bank, fromAccount: account.id, msisdn: normalizeMsisdn(String(need(b.msisdn as string, "msisdn"))), amount: amountOf(b.amount), reference: (b.narration as string) ?? undefined });
        return statusOf(r.txnId, r.fee);
      }
    }
    throw new HttpError(404, `No such endpoint: POST ${path}`);
  });
});

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team, bank, path } = await setup(ctx);
  const { w, client } = requirePartner(req, team, bank);
  const account = clientAccount(w, client);
  if (path === "v1/account") return { accountNumber: account.account_no, accountName: account.name, bankCode: bank, bankName: bankName(bank), availableBalance: account.balance / 100, currency: "GHS", status: account.status };
  if (path === "v1/account/transactions") {
    const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50, 200);
    const rows = w.db.prepare("SELECT * FROM txns WHERE from_account = ? OR to_account = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(account.id, account.id, limit) as Record<string, string | number | null>[];
    return {
      transactions: rows.map((t) => ({
        transactionId: t.id, at: new Date(t.created_at as number).toISOString(), type: t.type, direction: t.from_account === account.id ? "debit" : "credit",
        amount: (t.amount as number) / 100, fee: t.from_account === account.id ? (t.fee as number) / 100 : 0, status: t.status, narration: t.reference ?? undefined, reason: t.reason ?? undefined,
      })),
    };
  }
  const m = path.match(/^v1\/transfers\/([\w-]+)$/);
  if (m) {
    const t = getTxn(w, m[1]);
    if (!t || t.from_account !== account.id) throw new HttpError(404, "Transfer not found");
    return { transactionId: t.id, status: t.status === "success" ? "SUCCESSFUL" : t.status.toUpperCase(), amount: t.amount / 100, fee: t.fee / 100, currency: "GHS", reason: t.reason ?? undefined };
  }
  throw new HttpError(404, `No such endpoint: GET ${path}`);
});
