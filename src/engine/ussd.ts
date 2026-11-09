import { getConfig } from "./config/store";
import type { Menu, MenuNode } from "./config/schemas";
import { computeFacts, evaluate, type Facts } from "./facts";
import { cedis, clock, render } from "./notify";
import { getWallet, quoteFee, reportFraud, transfer, walletByMsisdn, type TransferRequest, type WalletRow } from "./payments";
import { approveRtp, rejectRtp } from "./rtp";
import type { UssdSession, World } from "./world";
import { TELCO_INFO, newId, normalizeMsisdn } from "./util";

export interface UssdReply {
  sessionId: string;
  text: string;
  end: boolean;
}

const MAX_STEPS = 50;

export async function ussd(w: World, args: { sessionId?: string; msisdn: string; input: string; newDevice?: boolean }): Promise<UssdReply> {
  const wallet = walletByMsisdn(w, args.msisdn);
  if (!wallet) return { sessionId: "", text: "This number is not registered for mobile money.", end: true };
  const menu = getConfig(w.db, "menus")[wallet.telco];

  let s = args.sessionId ? w.ussd.get(args.sessionId) : undefined;
  if (!s) {
    const code = args.input.trim();
    if (code !== menu.shortcode) return { sessionId: "", text: `Unknown USSD code. ${TELCO_INFO[wallet.telco].wallet} is ${menu.shortcode}`, end: true };
    s = { id: newId("ussd"), msisdn: wallet.msisdn, telco: wallet.telco, node: menu.start, vars: {}, startedAt: Date.now(), lastAt: Date.now() };
    w.ussd.set(s.id, s);
    return reply(w, s, await advance(w, s, menu, wallet));
  }

  if (Date.now() - s.lastAt > menu.sessionTimeoutSec * 1000) {
    w.ussd.delete(s.id);
    return { sessionId: s.id, text: "Session timed out. Please dial again.", end: true };
  }
  s.lastAt = Date.now();
  const input = args.input.trim();

  if (s.pending) return reply(w, s, await handlePending(w, s, menu, wallet, input));

  const node = menu.nodes[s.node];
  if (!node) return reply(w, s, end("Service unavailable (menu error)."));

  if (node.type === "menu") {
    const opt = node.options.find((o) => o.key === input);
    if (!opt) return reply(w, s, { text: "Invalid option\n" + renderNode(w, s, menu, node, wallet), end: false });
    s.node = opt.next;
  } else if (node.type === "warning") {
    if (input !== "1") return reply(w, s, end("Transaction cancelled. Stay safe."));
    s.vars.warned = "1";
    s.node = node.next;
  } else if (node.type === "input") {
    const err = acceptInput(w, s, node.var, node.kind, input, wallet);
    if (err) return reply(w, s, err.end ? end(err.text) : { text: `${err.text}\n${renderNode(w, s, menu, node, wallet)}`, end: false });
    s.node = node.next;
  } else {
    return reply(w, s, end("Session ended."));
  }
  return reply(w, s, await advance(w, s, menu, wallet));
}

function reply(w: World, s: UssdSession, r: { text: string; end: boolean }): UssdReply {
  if (r.end) w.ussd.delete(s.id);
  const limit = getConfig(w.db, "menus")[s.telco as WalletRow["telco"]].screenCharLimit;
  const text = r.text.length > limit ? r.text.slice(0, limit - 1) + "…" : r.text;
  return { sessionId: s.id, text, end: r.end };
}

const end = (text: string) => ({ text, end: true });

/** Walks non-display nodes (branch, set, action) until something must be shown. */
async function advance(w: World, s: UssdSession, menu: Menu, wallet: WalletRow): Promise<{ text: string; end: boolean }> {
  for (let i = 0; i < MAX_STEPS; i++) {
    const node = menu.nodes[s.node];
    if (!node) return end("Service unavailable (menu error).");
    switch (node.type) {
      case "branch":
        s.node = evaluate(node.if, draftFacts(w, s, wallet)) ? node.then : node.else;
        continue;
      case "set":
        Object.assign(s.vars, node.vars);
        s.node = node.next;
        continue;
      case "action":
        return runAction(w, s, node.action, wallet);
      case "message":
        return end(renderText(w, s, node.text, wallet));
      default:
        return { text: renderNode(w, s, menu, node, wallet), end: false };
    }
  }
  return end("Service unavailable (menu loop).");
}

function renderNode(w: World, s: UssdSession, _menu: Menu, node: MenuNode, wallet: WalletRow): string {
  if (node.type === "menu") return [renderText(w, s, node.text, wallet), ...node.options.map((o) => `${o.key}) ${o.label}`)].join("\n");
  if (node.type === "input") return renderText(w, s, node.text, wallet);
  if (node.type === "warning") return `${renderText(w, s, node.text, wallet)}\n1) Continue\n2) Cancel`;
  return "";
}

function renderText(w: World, s: UssdSession, text: string, wallet: WalletRow): string {
  const v = s.vars;
  const recipient = v.recipient ? walletByMsisdn(w, v.recipient) : undefined;
  const merchant = v.till ? merchantWallet(w, v.till) : undefined;
  const bank = v.account ? bankByNumber(w, v.account) : undefined;
  const counterparty = recipient ?? merchant;
  const amount = v.amount ? Math.round(Number(v.amount) * 100) : 0;
  const type = v.till ? "merchant" : v.account ? "to_bank" : "p2p";
  return render(text, {
    ...v,
    amount: v.amount ? cedis(amount) : "",
    recipient_name: counterparty?.display_name ?? (bank ? `${bank.name} (${bank.bank})` : v.recipient ? "Unregistered" : ""),
    fee: amount ? cedis(quoteFee(w, type, wallet, counterparty, amount)) : "0.00",
    balance: cedis(wallet.balance),
    telco: TELCO_INFO[wallet.telco].wallet,
  });
}

function draftFacts(w: World, s: UssdSession, wallet: WalletRow): Partial<Facts> {
  const to = s.vars.recipient ? walletByMsisdn(w, s.vars.recipient) : s.vars.till ? merchantWallet(w, s.vars.till) : undefined;
  return computeFacts(w, {
    type: s.vars.till ? "merchant" : s.vars.account ? "to_bank" : "p2p",
    channel: "ussd",
    fromWallet: wallet.id,
    toWallet: to?.id,
    recipientType: to?.owner_type ?? (s.vars.account ? "bank" : "person"),
    amount: Math.round(Number(s.vars.amount ?? 0) * 100),
    crossNetwork: !!to && to.telco !== wallet.telco,
  });
}

function acceptInput(w: World, s: UssdSession, varName: string, kind: string, input: string, wallet: WalletRow): { text: string; end?: boolean } | undefined {
  switch (kind) {
    case "msisdn": {
      const n = normalizeMsisdn(input);
      if (!/^0\d{9}$/.test(n)) return { text: "Invalid number" };
      if (varName === "recipient_confirm" && s.vars.recipient && n !== s.vars.recipient) return { text: "Numbers do not match.", end: true };
      if (varName === "recipient" && n === wallet.msisdn) return { text: "You cannot send to yourself" };
      s.vars[varName] = n;
      return;
    }
    case "amount": {
      const a = Number(input);
      if (!Number.isFinite(a) || a <= 0 || Math.round(a * 100) !== a * 100) return { text: "Invalid amount" };
      s.vars[varName] = String(a);
      return;
    }
    case "pin":
      if (!/^\d{4}$/.test(input)) return { text: "PIN must be 4 digits" };
      s.vars[varName] = input;
      return;
    case "till":
      if (!merchantWallet(w, input)) return { text: "Merchant ID not found" };
      s.vars[varName] = input;
      return;
    case "account":
      if (!bankByNumber(w, input)) return { text: "Account not found" };
      s.vars[varName] = input;
      return;
    case "agent":
      if (!w.db.prepare("SELECT 1 FROM agents WHERE code = ?").get(input)) return { text: "Agent code not found" };
      s.vars[varName] = input;
      return;
    default:
      s.vars[varName] = input.slice(0, 40);
  }
}

const merchantWallet = (w: World, till: string) => {
  const m = w.db.prepare("SELECT wallet_id FROM merchants WHERE till = ?").get(till) as { wallet_id: string } | undefined;
  return m ? getWallet(w, m.wallet_id) : undefined;
};
const bankByNumber = (w: World, n: string) =>
  w.db.prepare("SELECT id, name, bank FROM bank_accounts WHERE account_no = ?").get(n) as { id: string; name: string; bank: string } | undefined;

async function runAction(w: World, s: UssdSession, action: string, wallet: WalletRow): Promise<{ text: string; end: boolean }> {
  const v = s.vars;
  const amount = Math.round(Number(v.amount ?? 0) * 100);
  const base = { channel: "ussd", initiatedBy: "human", from: wallet.id, pin: v.pin, amount, reference: v.reference, warned: v.warned === "1" } as const;

  switch (action) {
    case "send_money": {
      const to = v.recipient ? walletByMsisdn(w, v.recipient) : undefined;
      if (!to) return end("Recipient is not registered for mobile money.");
      return doTransfer(w, s, { ...base, type: "p2p", to: to.id });
    }
    case "pay_merchant": {
      const to = v.till ? merchantWallet(w, v.till) : undefined;
      if (!to) return end("Merchant ID not found.");
      return doTransfer(w, s, { ...base, type: "merchant", to: to.id });
    }
    case "to_bank": {
      const b = v.account ? bankByNumber(w, v.account) : undefined;
      if (!b) return end("Account not found.");
      return doTransfer(w, s, { ...base, type: "to_bank", bankAccount: b.id });
    }
    case "cash_out":
      return end("Visit an agent. The agent starts the cash-out and you approve it under Allow Cash Out.");
    case "check_balance":
      if (v.pin !== wallet.pin) return end("Wrong PIN");
      return end(`Your ${TELCO_INFO[wallet.telco].wallet} balance is GHS ${cedis(wallet.balance)}.`);
    case "mini_statement": {
      if (v.pin !== wallet.pin) return end("Wrong PIN");
      const rows = w.db
        .prepare("SELECT * FROM txns WHERE (from_wallet = ? OR to_wallet = ?) AND status IN ('success','held','reversed') ORDER BY created_at DESC LIMIT 4")
        .all(wallet.id, wallet.id) as { from_wallet: string; amount: number; created_at: number; status: string }[];
      if (!rows.length) return end("No recent transactions.");
      return end(rows.map((r) => `${clock(r.created_at)} ${r.from_wallet === wallet.id ? "-" : "+"}${cedis(r.amount)}${r.status !== "success" ? ` (${r.status})` : ""}`).join("\n"));
    }
    case "approvals": {
      const list = w.db.prepare("SELECT r.ref, r.amount, w.display_name FROM rtp r JOIN wallets w ON w.id = r.payee_wallet WHERE r.payer_msisdn = ? AND r.status = 'PENDING' ORDER BY r.created_at DESC LIMIT 5").all(wallet.msisdn) as {
        ref: string;
        amount: number;
        display_name: string;
      }[];
      if (!list.length) return end("You have no pending approvals.");
      s.pending = { kind: "approvals", data: { step: "pick", refs: list.map((l) => l.ref) } };
      return { text: ["Pending approvals", ...list.map((l, i) => `${i + 1}) Pay GHS ${cedis(l.amount)} to ${l.display_name}`)].join("\n"), end: false };
    }
    case "report_fraud": {
      const rows = w.db
        .prepare("SELECT t.id, t.amount, t.status, COALESCE(w.msisdn, '') AS msisdn FROM txns t LEFT JOIN wallets w ON w.id = t.to_wallet WHERE t.from_wallet = ? AND t.status IN ('success','held') ORDER BY t.created_at DESC LIMIT 3")
        .all(wallet.id) as { id: string; amount: number; status: string; msisdn: string }[];
      if (!rows.length) return end("No recent payments to report.");
      s.pending = { kind: "approvals", data: { step: "report", ids: rows.map((r) => r.id) } };
      return { text: ["Which payment was fraud?", ...rows.map((r, i) => `${i + 1}) GHS ${cedis(r.amount)} to ${r.msisdn}${r.status === "held" ? " (on hold)" : ""}`)].join("\n"), end: false };
    }
  }
  return end("Unknown action.");
}

async function doTransfer(w: World, s: UssdSession, req: TransferRequest): Promise<{ text: string; end: boolean }> {
  const r = await transfer(w, req);
  if (r.status === "needs_warning_ack") {
    s.pending = { kind: "warning", data: req };
    return { text: `${r.message}\n1) Continue\n2) Cancel`, end: false };
  }
  if (r.status === "needs_otp") {
    s.pending = { kind: "otp", data: req };
    return { text: r.message, end: false };
  }
  return end(r.message);
}

async function handlePending(w: World, s: UssdSession, _menu: Menu, wallet: WalletRow, input: string): Promise<{ text: string; end: boolean }> {
  const p = s.pending!;
  s.pending = undefined;
  if (p.kind === "warning") {
    if (input !== "1") return end("Transaction cancelled. Stay safe.");
    return doTransfer(w, s, { ...(p.data as TransferRequest), acknowledgedWarning: true });
  }
  if (p.kind === "otp") return doTransfer(w, s, { ...(p.data as TransferRequest), otp: input });

  const d = p.data as { step: string; refs?: string[]; ids?: string[]; ref?: string };
  if (d.step === "report") {
    const id = d.ids?.[Number(input) - 1];
    if (!id) return end("Invalid option");
    const reversed = reportFraud(w, id, wallet.msisdn, "customer_report");
    return end(reversed ? "Report received. The payment was on hold and your money has been returned." : "Report received. Our fraud team will contact you.");
  }
  if (d.step === "pick") {
    const ref = d.refs?.[Number(input) - 1];
    if (!ref) return end("Invalid option");
    s.pending = { kind: "approvals", data: { step: "decide", ref } };
    return { text: "1) Approve (money leaves your wallet)\n2) Reject", end: false };
  }
  if (d.step === "decide") {
    if (input === "2") {
      rejectRtp(w, d.ref!, "Rejected by payer");
      return end("Request rejected.");
    }
    s.pending = { kind: "approvals", data: { step: "pin", ref: d.ref } };
    return { text: "Enter PIN to approve", end: false };
  }
  if (d.step === "pin") {
    if (input !== wallet.pin) return end("Wrong PIN");
    return approve(w, s, d.ref!, {});
  }
  if (d.step === "rtp_warn") {
    if (input !== "1") {
      rejectRtp(w, d.ref!, "Cancelled by payer after warning");
      return end("Request rejected. Stay safe.");
    }
    return approve(w, s, d.ref!, { acknowledgedWarning: true });
  }
  if (d.step === "rtp_otp") return approve(w, s, d.ref!, { acknowledgedWarning: true, otp: input });
  return end("Session ended.");
}

async function approve(w: World, s: UssdSession, ref: string, opts: { acknowledgedWarning?: boolean; otp?: string }) {
  const r = await approveRtp(w, ref, { initiatedBy: "human", ...opts });
  if (r.status === "needs_warning_ack") {
    s.pending = { kind: "approvals", data: { step: "rtp_warn", ref } };
    return { text: `${r.message}\n1) Continue\n2) Cancel`, end: false };
  }
  if (r.status === "needs_otp") {
    s.pending = { kind: "approvals", data: { step: "rtp_otp", ref } };
    return { text: r.message, end: false };
  }
  return end(r.message);
}
