import { approve, getApproval, pendingFor, rejectApproval } from "./approvals";
import { openTicket } from "./care";
import { getConfig } from "./config/store";
import type { Condition, FactName, Menu, MenuNode } from "./config/schemas";
import { accountByNumber, checkPin, feeFor, getWallet, walletByMsisdn, type WalletRow } from "./ledger";
import { fullName, personById } from "./nia";
import { render } from "./notify";
import { Confirm, emit } from "./integrations";
import { toBankFee, walletPay, walletToBank, type Receipt } from "./payments";
import { changePin, getSim, pinProblem, selfRegisterWallet, type SimRow } from "./telco";
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
    const problem = pinProblem(w, s.msisdn, input, "new_wallet");
    if (problem) return show(`${problem}\nCreate a 4-digit PIN`);
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

/**
 * Makes a payment. If an API plugged into the network asks for a warning first, the customer sees it
 * and must choose to continue; `again` records how to carry on if they do.
 */
function pay(w: World, s: UssdSession, wallet: WalletRow, again: { kind: string; data?: unknown }, go: () => Receipt): Screen {
  try {
    return end(go().message);
  } catch (e) {
    if (!(e instanceof Confirm)) throw e;
    s.pending = again;
    emit(w, wallet.telco, "payment.warning_shown", { payer: wallet.msisdn, network: wallet.telco, warning: e.message });
    return show(`${e.message}\n1) Continue\n2) Cancel`);
  }
}

function runAction(w: World, s: UssdSession, action: string, wallet: WalletRow, acknowledged = false): Screen {
  const v = s.vars;
  const d = draft(w, s, wallet);
  const attempts = getConfig(w.db, `telco.${wallet.telco}`).pinAttemptsBeforeLock;

  switch (action) {
    case "send_money":
      if (!d.to) return end("Recipient is not registered for mobile money.");
      return pay(w, s, wallet, { kind: "warned", data: { action } }, () => walletPay(w, { type: "p2p", channel: "ussd", from: wallet.id, to: d.to!.id, amount: d.amount, pin: v.pin ?? "", reference: v.reference, acknowledged }));
    case "pay_merchant":
      if (!d.to) return end("Merchant ID not found.");
      return pay(w, s, wallet, { kind: "warned", data: { action } }, () => walletPay(w, { type: "merchant", channel: "ussd", from: wallet.id, to: d.to!.id, amount: d.amount, pin: v.pin ?? "", reference: v.reference, acknowledged }));
    case "to_bank":
      if (!d.bank) return end("Account not found.");
      return pay(w, s, wallet, { kind: "warned", data: { action } }, () => walletToBank(w, { from: wallet.id, accountNo: d.bank!.account_no, amount: d.amount, pin: v.pin ?? "", reference: v.reference, channel: "ussd", acknowledged }));
    case "check_balance":
      checkPin(w, wallet, v.pin ?? "", attempts);
      return end(`Your ${TELCO_INFO[wallet.telco].wallet} balance is GHS ${cedis(wallet.balance)}.`);
    case "mini_statement": {
      checkPin(w, wallet, v.pin ?? "", attempts);
      const rows = w.db
        .prepare("SELECT from_wallet, amount, created_at, status, type FROM txns WHERE (from_wallet = ? OR to_wallet = ?) AND status IN ('success','reversed') ORDER BY created_at DESC LIMIT 4")
        .all(wallet.id, wallet.id) as { from_wallet: string; amount: number; created_at: number; status: string; type: string }[];
      if (!rows.length) return end("No recent transactions.");
      return end(rows.map((r) => `${clock(r.created_at)} ${r.from_wallet === wallet.id || r.type === "hold" ? "-" : "+"}${cedis(r.amount)}${r.status !== "success" ? ` (${r.status})` : ""}`).join("\n"));
    }
    case "approvals": {
      const list = pendingFor(w, wallet.msisdn);
      if (!list.length) return end("You have no pending approvals.");
      s.pending = { kind: "approvals", data: { step: "pick", refs: list.map((l) => l.ref) } };
      const line = (l: (typeof list)[number]) =>
        l.kind === "dispute"
          ? `Return GHS ${cedis(l.amount)} to ${l.display_name} (sent by mistake)`
          : l.kind === "preapproval"
            ? `Let ${l.display_name} take payments without asking`
            : l.kind === "consent"
              ? `Share your details with ${l.payer_message}`
              : `${l.kind === "cashout" ? "Cash out" : "Pay"} GHS ${cedis(l.amount)} ${l.kind === "cashout" ? "at" : "to"} ${l.display_name}`;
      return show(["Pending approvals", ...list.map((l, i) => `${i + 1}) ${line(l)}`)].join("\n"));
    }
    case "change_pin":
      s.pending = { kind: "change_pin", data: { step: "old" } };
      return show("Enter your current PIN");
    case "report_problem": {
      const rows = w.db
        .prepare("SELECT t.id, t.amount, t.type, COALESCE(x.display_name, '') AS name FROM txns t LEFT JOIN wallets x ON x.id = t.to_wallet WHERE t.from_wallet = ? AND t.status = 'success' AND t.type IN ('p2p','merchant','cashout') ORDER BY t.created_at DESC, t.rowid DESC LIMIT 3")
        .all(wallet.id) as { id: string; amount: number; type: string; name: string }[];
      if (!rows.length) return end(`You have no recent payments to report. For anything else, call ${TELCO_INFO[wallet.telco].careLine}.`);
      s.pending = { kind: "report", data: { step: "pick", ids: rows.map((r) => r.id), types: rows.map((r) => r.type) } };
      return show(["Which payment is the problem?", ...rows.map((r, i) => `${i + 1}) GHS ${cedis(r.amount)} ${r.type === "cashout" ? "cash out at" : "to"} ${r.name}`)].join("\n"));
    }
  }
  return end("Unknown action.");
}

function handlePending(w: World, s: UssdSession, wallet: WalletRow, input: string): Screen {
  const p = s.pending!;
  s.pending = undefined;
  const d = p.data as { step: string; refs?: string[]; ref?: string; pin?: string; ids?: string[]; types?: string[]; id?: string; agent?: boolean; action?: string };

  if (p.kind === "warned") {
    // The customer has read a warning from an API plugged into the network.
    if (input !== "1") {
      emit(w, wallet.telco, "payment.cancelled_after_warning", { payer: wallet.msisdn, network: wallet.telco });
      return end("Payment cancelled. No money has left your wallet.");
    }
    if (d.ref) return pay(w, s, wallet, p, () => approve(w, d.ref!, d.pin ?? "", true));
    return runAction(w, s, d.action ?? "", wallet, true);
  }

  if (p.kind === "report") {
    if (d.step === "pick") {
      const i = Number(input) - 1;
      const id = d.ids?.[i];
      if (!id) return end("Invalid option");
      const agent = d.types?.[i] === "cashout";
      s.pending = { kind: "report", data: { step: "why", id, agent } };
      return show(agent ? "What went wrong?\n1) The agent did not give me my cash\n2) I did not make this withdrawal" : "What went wrong?\n1) I sent it to the wrong number\n2) I did not make this payment");
    }
    if (input !== "1" && input !== "2") return end("Invalid option");
    const category = input === "2" ? "unauthorised" : d.agent ? "agent_complaint" : "wrong_transfer";
    const t = openTicket(w, wallet.telco, { msisdn: wallet.msisdn, category, txnId: d.id, channel: "ussd", by: "the customer, from their phone" });
    return end(`Your complaint has been received. Ticket ${t.id}. Customer care will update you by SMS. Call ${TELCO_INFO[wallet.telco].careLine} for help.`);
  }

  if (p.kind === "change_pin") {
    if (d.step === "old") {
      checkPin(w, wallet, input, getConfig(w.db, `telco.${wallet.telco}`).pinAttemptsBeforeLock);
      s.pending = { kind: "change_pin", data: { step: "new" } };
      return show("Enter a new 4-digit PIN");
    }
    if (d.step === "new") {
      const problem = pinProblem(w, wallet.msisdn, input, "change");
      if (problem) {
        s.pending = { kind: "change_pin", data: { step: "new" } };
        return show(`${problem}\nEnter a new 4-digit PIN`);
      }
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
    const kind = getApproval(w, ref)?.kind;
    return show(
      kind === "dispute" ? "1) Agree to return the money\n2) Refuse" : kind === "preapproval" ? "1) Allow (they can charge you without asking)\n2) Refuse" : kind === "consent" ? "1) Share my details\n2) Refuse" : "1) Approve (money leaves your wallet)\n2) Reject",
    );
  }
  if (d.step === "decide") {
    if (input !== "1") {
      const kind = getApproval(w, d.ref!)?.kind;
      rejectApproval(w, d.ref!, "Rejected by payer");
      return end(kind === "dispute" ? "You have refused. Customer care will review the claim." : kind === "preapproval" || kind === "consent" ? "You have refused." : "Request rejected.");
    }
    s.pending = { kind: "approvals", data: { step: "pin", ref: d.ref } };
    return show("Enter PIN to approve");
  }
  if (d.step === "pin") return pay(w, s, wallet, { kind: "warned", data: { ref: d.ref, pin: input } }, () => approve(w, d.ref!, input));
  return end("Session ended.");
}
