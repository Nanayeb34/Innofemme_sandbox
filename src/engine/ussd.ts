import { approve, pendingFor, rejectApproval } from "./approvals";
import { getConfig } from "./config/store";
import type { Condition, FactName, Menu, MenuNode } from "./config/schemas";
import { accountByNumber, checkPin, feeFor, getWallet, walletByMsisdn, type WalletRow } from "./ledger";
import { fullName, personById } from "./nia";
import { render } from "./notify";
import { toBankFee, walletPay, walletToBank } from "./payments";
import { changePin, getSim, selfRegisterWallet, type SimRow } from "./telco";
import { SimError, TELCO_INFO, bankName, cedis, clock, newId, normalizeMsisdn } from "./util";
import type { UssdSession, World } from "./world";

/** The USSD session engine: runs each telco's editable menu tree for whoever is holding the phone. */

export interface UssdReply {
  sessionId: string;
  text: string;
  end: boolean;
}
type Screen = { text: string; end: boolean };

const MAX_STEPS = 50;
/** Works on every network: tells the caller who the SIM is registered to. */
export const REGISTRATION_CHECK_CODE = "*400#";
/** Lists every number registered to the caller's Ghana Card, on all networks. */
export const LINKED_SIMS_CODE = "*402*1#";
export const OWN_NUMBER_CODE = { mtn: "*156#", telecel: "*127#", at: "*703#" } as const;
const end = (text: string): Screen => ({ text, end: true });
const show = (text: string): Screen => ({ text, end: false });

export function ussd(w: World, args: { sessionId?: string; msisdn: string; input: string }): UssdReply {
  const sim = getSim(w, args.msisdn);
  const none = (text: string): UssdReply => ({ sessionId: "", text, end: true });
  if (!sim || sim.status === "in_stock") return none("SIM not registered. Visit a SIM registration point with your Ghana Card.");
  if (sim.status !== "active") return none(sim.status === "blocked" ? "This SIM is blocked. Visit a service centre." : "This number has been disconnected.");
  const cfg = getConfig(w.db, `telco.${sim.telco}`);
  const menu = cfg.menu;
  const brand = TELCO_INFO[sim.telco];

  let s = args.sessionId ? w.ussd.get(args.sessionId) : undefined;
  if (!s) {
    const dialled = args.input.trim();
    if (dialled === REGISTRATION_CHECK_CODE) return none(registrationStatus(w, sim));
    if (dialled === LINKED_SIMS_CODE) return none(linkedSims(w, sim));
    if (dialled === OWN_NUMBER_CODE[sim.telco]) return none(`Your number is ${sim.msisdn}`);
    if (dialled === "*124#") return none("Airtime is not part of the sandbox.");
    if (dialled !== menu.shortcode) return none(`Unknown USSD code. ${brand.wallet} is ${menu.shortcode}. Other codes: ${REGISTRATION_CHECK_CODE} registration status, ${LINKED_SIMS_CODE} numbers on your Ghana Card, ${OWN_NUMBER_CODE[sim.telco]} your number.`);
    s = { id: newId("ussd"), msisdn: sim.msisdn, telco: sim.telco, node: menu.start, vars: {}, startedAt: Date.now(), lastAt: Date.now() };
    w.ussd.set(s.id, s);
    const wallet = walletByMsisdn(w, sim.msisdn);
    if (!wallet) {
      if (!cfg.selfRegistration) return reply(w, s, end(`You are not registered for ${brand.wallet}. Visit a ${brand.wallet} agent with your Ghana Card.`));
      s.pending = { kind: "register", data: { step: "offer" } };
      return reply(w, s, show(`Welcome to ${brand.wallet}. This number has no wallet yet.\n1) Register now\n2) Cancel`));
    }
    return reply(w, s, guard(() => advance(w, s!, menu, wallet)));
  }

  if (Date.now() - s.lastAt > menu.sessionTimeoutSec * 1000) {
    w.ussd.delete(s.id);
    return { sessionId: s.id, text: "Session timed out. Please dial again.", end: true };
  }
  s.lastAt = Date.now();
  const input = args.input.trim();
  const session = s;
  return reply(
    w,
    session,
    guard(() => {
      if (session.pending?.kind === "register") return handleRegistration(w, session, input);
      const wallet = walletByMsisdn(w, session.msisdn);
      if (!wallet) return end("Session ended.");
      if (session.pending) return handlePending(w, session, wallet, input);

      const node = menu.nodes[session.node];
      if (!node) return end("Service unavailable (menu error).");
      if (node.type === "menu") {
        const opt = node.options.find((o) => o.key === input);
        if (!opt) return show(`Invalid option.\n${renderNode(w, session, node, wallet)}`);
        session.node = opt.next;
      } else if (node.type === "warning") {
        if (input !== "1") return end("Cancelled.");
        session.node = node.next;
      } else if (node.type === "input") {
        const err = acceptInput(w, session, node.var, node.kind, input, wallet);
        if (err) return err.end ? end(err.text) : show(`${err.text}\n${renderNode(w, session, node, wallet)}`);
        session.node = node.next;
      } else {
        return end("Session ended.");
      }
      return advance(w, session, menu, wallet);
    }),
  );
}

/** A broken rule ends the session with its message, as a real handset would show it. */
function guard(fn: () => Screen): Screen {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SimError) return end(e.message);
    throw e;
  }
}

function reply(w: World, s: UssdSession, r: Screen): UssdReply {
  if (r.end) w.ussd.delete(s.id);
  const limit = getConfig(w.db, `telco.${s.telco}`).menu.screenCharLimit;
  const text = r.text.length > limit ? r.text.slice(0, limit - 1) + "…" : r.text;
  return { sessionId: s.id, text, end: r.end };
}

function registrationStatus(w: World, sim: SimRow): string {
  const p = sim.person_id ? personById(w, sim.person_id) : undefined;
  if (!p) return "This SIM is not registered.";
  const masked = p.ghana_card.replace(/^(\w{3}-)\d{5}/, "$1*****");
  return `${sim.msisdn} is registered to ${fullName(p)}.\nGhana Card: ${masked}\nNetwork: ${TELCO_INFO[sim.telco].name}`;
}

function linkedSims(w: World, sim: SimRow): string {
  const rows = w.db.prepare("SELECT msisdn, telco FROM sims WHERE person_id = ? AND status IN ('active','blocked') ORDER BY registered_at").all(sim.person_id ?? "") as { msisdn: string; telco: keyof typeof TELCO_INFO }[];
  return [`Numbers on your Ghana Card (${rows.length}):`, ...rows.map((r) => `${r.msisdn.slice(0, 3)}****${r.msisdn.slice(7)} ${TELCO_INFO[r.telco].name}`)].join("\n");
}

function handleRegistration(w: World, s: UssdSession, input: string): Screen {
  const d = s.pending!.data as { step: string; pin?: string };
  const brand = TELCO_INFO[s.telco as keyof typeof TELCO_INFO];
  if (d.step === "offer") {
    if (input !== "1") return end("Cancelled.");
    s.pending = { kind: "register", data: { step: "pin" } };
    return show("Create a 4-digit PIN for your wallet. Keep it secret.");
  }
  if (d.step === "pin") {
    if (!/^\d{4}$/.test(input)) return show("PIN must be 4 digits.\nCreate a 4-digit PIN");
    s.pending = { kind: "register", data: { step: "confirm", pin: input } };
    return show("Enter the PIN again to confirm");
  }
  if (input !== d.pin) return end("PINs do not match. Dial again to register.");
  selfRegisterWallet(w, s.msisdn, input);
  return end(`You are now registered for ${brand.wallet}. Dial ${brand.shortcode} to use your wallet. Visit an agent with your Ghana Card to raise your limits.`);
}

/** Walks non-display nodes (branch, action) until something must be shown. */
function advance(w: World, s: UssdSession, menu: Menu, wallet: WalletRow): Screen {
  for (let i = 0; i < MAX_STEPS; i++) {
    const node = menu.nodes[s.node];
    if (!node) return end("Service unavailable (menu error).");
    switch (node.type) {
      case "branch":
        s.node = evaluate(node.if, facts(w, s, wallet)) ? node.then : node.else;
        continue;
      case "action":
        return runAction(w, s, node.action, wallet);
      case "message":
        return end(renderText(w, s, node.text, wallet));
      default:
        return show(renderNode(w, s, node, wallet));
    }
  }
  return end("Service unavailable (menu loop).");
}

function renderNode(w: World, s: UssdSession, node: MenuNode, wallet: WalletRow): string {
  if (node.type === "menu") return [renderText(w, s, node.text, wallet), ...node.options.map((o) => `${o.key}) ${o.label}`)].join("\n");
  if (node.type === "input") return renderText(w, s, node.text, wallet);
  if (node.type === "warning") return `${renderText(w, s, node.text, wallet)}\n1) Continue\n2) Cancel`;
  return "";
}

const merchantWallet = (w: World, till: string) => {
  const m = w.db.prepare("SELECT wallet_id FROM merchants WHERE till = ?").get(till) as { wallet_id: string } | undefined;
  return m ? getWallet(w, m.wallet_id) : undefined;
};

/** What the session knows so far about the payment being built. */
function draft(w: World, s: UssdSession, wallet: WalletRow) {
  const v = s.vars;
  const recipient = v.recipient ? walletByMsisdn(w, v.recipient) : undefined;
  const merchant = v.till ? merchantWallet(w, v.till) : undefined;
  const bank = v.account ? accountByNumber(w, v.account) : undefined;
  const to = recipient ?? merchant;
  const amount = v.amount ? Math.round(Number(v.amount) * 100) : 0;
  const cross = !!to && to.telco !== wallet.telco;
  const fees = getConfig(w.db, `telco.${wallet.telco}`).fees;
  const fee = !amount ? 0 : v.till ? feeFor(fees.merchant, amount) : bank ? toBankFee(w, wallet, bank, amount) : feeFor(cross ? fees.p2p_offnet : fees.p2p_onnet, amount);
  return { to, bank, amount, cross, fee };
}

function renderText(w: World, s: UssdSession, text: string, wallet: WalletRow): string {
  const v = s.vars;
  const d = draft(w, s, wallet);
  return render(text, {
    ...v,
    amount: v.amount ? cedis(d.amount) : "",
    recipient_name: d.to?.display_name ?? (d.bank ? `${d.bank.name} (${bankName(d.bank.bank)})` : v.recipient ? "Unregistered" : ""),
    fee: cedis(d.fee),
    balance: cedis(wallet.balance),
    telco: TELCO_INFO[wallet.telco].wallet,
  });
}

function facts(w: World, s: UssdSession, wallet: WalletRow): Record<FactName, number | string | boolean> {
  const d = draft(w, s, wallet);
  return {
    amount: d.amount / 100,
    cross_network: d.cross,
    recipient_registered: !!d.to,
    recipient_type: d.to?.owner_type ?? (d.bank ? "bank" : "person"),
    sender_kyc_tier: wallet.kyc_tier,
    sender_balance: wallet.balance / 100,
    hour_of_day: new Date(w.now).getUTCHours(),
  };
}

export function evaluate(c: Condition, f: Partial<Record<FactName, number | string | boolean>>): boolean {
  if ("all" in c) return c.all.every((x) => evaluate(x, f));
  if ("any" in c) return c.any.some((x) => evaluate(x, f));
  if ("not" in c) return !evaluate(c.not, f);
  const actual = f[c.fact];
  if (actual === undefined) return false;
  const v = c.value;
  switch (c.op) {
    case ">":
      return Number(actual) > Number(v);
    case ">=":
      return Number(actual) >= Number(v);
    case "<":
      return Number(actual) < Number(v);
    case "<=":
      return Number(actual) <= Number(v);
    case "==":
      return actual === v || String(actual) === String(v);
    case "!=":
      return !(actual === v || String(actual) === String(v));
    case "in":
      return Array.isArray(v) && v.map(String).includes(String(actual));
  }
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
      if (!Number.isFinite(a) || a <= 0 || Math.abs(Math.round(a * 100) - a * 100) > 1e-6) return { text: "Invalid amount" };
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
      if (accountByNumber(w, input)?.kind !== "personal") return { text: "Account not found" };
      s.vars[varName] = input;
      return;
    default:
      s.vars[varName] = input.slice(0, 40);
  }
}

function runAction(w: World, s: UssdSession, action: string, wallet: WalletRow): Screen {
  const v = s.vars;
  const d = draft(w, s, wallet);
  const attempts = getConfig(w.db, `telco.${wallet.telco}`).pinAttemptsBeforeLock;

  switch (action) {
    case "send_money":
      if (!d.to) return end("Recipient is not registered for mobile money.");
      return end(walletPay(w, { type: "p2p", channel: "ussd", from: wallet.id, to: d.to.id, amount: d.amount, pin: v.pin ?? "", reference: v.reference }).message);
    case "pay_merchant":
      if (!d.to) return end("Merchant ID not found.");
      return end(walletPay(w, { type: "merchant", channel: "ussd", from: wallet.id, to: d.to.id, amount: d.amount, pin: v.pin ?? "", reference: v.reference }).message);
    case "to_bank":
      if (!d.bank) return end("Account not found.");
      return end(walletToBank(w, { from: wallet.id, accountNo: d.bank.account_no, amount: d.amount, pin: v.pin ?? "", reference: v.reference, channel: "ussd" }).message);
    case "check_balance":
      checkPin(w, wallet, v.pin ?? "", attempts);
      return end(`Your ${TELCO_INFO[wallet.telco].wallet} balance is GHS ${cedis(wallet.balance)}.`);
    case "mini_statement": {
      checkPin(w, wallet, v.pin ?? "", attempts);
      const rows = w.db
        .prepare("SELECT from_wallet, amount, created_at, status, type FROM txns WHERE (from_wallet = ? OR to_wallet = ?) AND status IN ('success','reversed') ORDER BY created_at DESC LIMIT 4")
        .all(wallet.id, wallet.id) as { from_wallet: string; amount: number; created_at: number; status: string; type: string }[];
      if (!rows.length) return end("No recent transactions.");
      return end(rows.map((r) => `${clock(r.created_at)} ${r.from_wallet === wallet.id ? "-" : "+"}${cedis(r.amount)}${r.status !== "success" ? ` (${r.status})` : ""}`).join("\n"));
    }
    case "approvals": {
      const list = pendingFor(w, wallet.msisdn);
      if (!list.length) return end("You have no pending approvals.");
      s.pending = { kind: "approvals", data: { step: "pick", refs: list.map((l) => l.ref) } };
      return show(["Pending approvals", ...list.map((l, i) => `${i + 1}) ${l.kind === "cashout" ? "Cash out" : "Pay"} GHS ${cedis(l.amount)} ${l.kind === "cashout" ? "at" : "to"} ${l.display_name}`)].join("\n"));
    }
    case "change_pin":
      s.pending = { kind: "change_pin", data: { step: "old" } };
      return show("Enter your current PIN");
  }
  return end("Unknown action.");
}

function handlePending(w: World, s: UssdSession, wallet: WalletRow, input: string): Screen {
  const p = s.pending!;
  s.pending = undefined;
  const d = p.data as { step: string; refs?: string[]; ref?: string; pin?: string };

  if (p.kind === "change_pin") {
    if (d.step === "old") {
      checkPin(w, wallet, input, getConfig(w.db, `telco.${wallet.telco}`).pinAttemptsBeforeLock);
      s.pending = { kind: "change_pin", data: { step: "new" } };
      return show("Enter a new 4-digit PIN");
    }
    if (d.step === "new") {
      if (!/^\d{4}$/.test(input)) return end("PIN must be 4 digits. PIN not changed.");
      s.pending = { kind: "change_pin", data: { step: "confirm", pin: input } };
      return show("Enter the new PIN again");
    }
    if (input !== d.pin) return end("PINs do not match. PIN not changed.");
    changePin(w, wallet, input);
    return end("Your PIN has been changed.");
  }

  if (d.step === "pick") {
    const ref = d.refs?.[Number(input) - 1];
    if (!ref) return end("Invalid option");
    s.pending = { kind: "approvals", data: { step: "decide", ref } };
    return show("1) Approve (money leaves your wallet)\n2) Reject");
  }
  if (d.step === "decide") {
    if (input !== "1") {
      rejectApproval(w, d.ref!, "Rejected by payer");
      return end("Request rejected.");
    }
    s.pending = { kind: "approvals", data: { step: "pin", ref: d.ref } };
    return show("Enter PIN to approve");
  }
  if (d.step === "pin") return end(approve(w, d.ref!, input).message);
  return end("Session ended.");
}
