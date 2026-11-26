/** What a new plug-in can start from in the Developer console, in each language. */

export type Lang = "javascript" | "python";

export interface Template {
  id: string;
  label: string;
  about: string;
  /** Where it is meant to be plugged in. */
  plugAt: string[];
  source: Record<Lang, string>;
}

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    about: "Allows everything and shows each question under Output. Start here and add your own rules.",
    plugAt: [],
    source: {
      javascript: `// MY PLUG-IN: start here.
//
// Plug it in at any step, then press Send a test to see what that step sends.
//
// The sandbox asks this one function a question:   decide(point, data, ctx)
//
//     point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
//                                 "events"            = something has just happened
//     data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
//                                 (the Test tab shows a real example for every step)
//     ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
//                                 ctx.at is the time now in the sandbox
//
// and you answer with one of:
//     { decision: "allow" }
//     { decision: "warn",   message: "..." }       the customer sees it, then Continue or Cancel
//     { decision: "delay",  minutes: 60, message: "..." }
//     { decision: "reject", message: "..." }
//
// console.log() shows under Output.

export function decide(point, data, ctx) {
  // 1. Look at what is about to happen.
  console.log("Asked about", point, data);

  // 2. Decide. Start simple: let everything through.
  return { decision: "allow" };
}
`,
      python: `"""MY PLUG-IN: start here.

Plug it in at any step, then press Send a test to see what that step sends.

The sandbox asks this one function a question:   decide(point, data, ctx)

    point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
                                "events"            = something has just happened
    data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
                                (the Test tab shows a real example for every step)
    ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
                                ctx.at is the time now in the sandbox

and you answer with one of:
    {"decision": "allow"}
    {"decision": "warn",   "message": "..."}       the customer sees it, then Continue or Cancel
    {"decision": "delay",  "minutes": 60, "message": "..."}
    {"decision": "reject", "message": "..."}

print() shows under Output.
"""

def decide(point, data, ctx):
    # 1. Look at what is about to happen.
    print("Asked about", point, data)

    # 2. Decide. Start simple: let everything through.
    return {"decision": "allow"}
`,
    },
  },
  {
    id: "new-payee",
    label: "New-payee warning",
    about: "Warns before money goes to a number the customer has rarely or never paid. Plug it into a network at payment.authorize and at events.",
    plugAt: ["events", "payment.authorize"],
    source: {
      javascript: `// NEW-PAYEE WARNING: warn before someone sends money to a number they don't usually pay.
//
// Plug it in twice on a network: at payment.authorize (to check) and at events (to learn).
//
// The sandbox asks this one function a question:   decide(point, data, ctx)
//
//     point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
//                                 "events"            = something has just happened
//     data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
//                                 (the Test tab shows a real example for every step)
//     ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
//                                 ctx.at is the time now in the sandbox
//
// and you answer with one of:
//     { decision: "allow" }
//     { decision: "warn",   message: "..." }       the customer sees it, then Continue or Cancel
//     { decision: "delay",  minutes: 60, message: "..." }
//     { decision: "reject", message: "..." }
//
// console.log() shows under Output.

const FAMILIAR_AFTER = 2; // after 2 payments to a number, stop warning about it

export function decide(point, data, ctx) {
  // We only look at money sent from one person to another.
  if (data.type !== "p2p") return { decision: "allow" };

  const payer = data.payer.msisdn; // who is sending
  const payee = data.payee.msisdn; // who is receiving
  const history = ctx.store.get(payer) ?? {}; // { number they paid: how many times }
  const times = history[payee] ?? 0;

  // 1. LEARN: a payment just went through, so remember it.
  if (point === "events" && data.event === "payment.completed") {
    history[payee] = times + 1;
    ctx.store.set(payer, history);
    console.log(\`Learned: \${payer} has paid \${payee} \${times + 1} time(s)\`);
    return { decision: "allow" };
  }

  // 2. CHECK: a payment is about to go through. Is the number familiar?
  if (point === "payment.authorize" && times < FAMILIAR_AFTER) {
    return { decision: "warn", message: \`You have paid \${payee} only \${times} time(s) before. Is this the right number?\` };
  }

  return { decision: "allow" };
}
`,
      python: `"""NEW-PAYEE WARNING: warn before someone sends money to a number they don't usually pay.

Plug it in twice on a network: at payment.authorize (to check) and at events (to learn).

The sandbox asks this one function a question:   decide(point, data, ctx)

    point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
                                "events"            = something has just happened
    data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
                                (the Test tab shows a real example for every step)
    ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
                                ctx.at is the time now in the sandbox

and you answer with one of:
    {"decision": "allow"}
    {"decision": "warn",   "message": "..."}       the customer sees it, then Continue or Cancel
    {"decision": "delay",  "minutes": 60, "message": "..."}
    {"decision": "reject", "message": "..."}

print() shows under Output.
"""

FAMILIAR_AFTER = 2  # after 2 payments to a number, stop warning about it


def decide(point, data, ctx):
    # We only look at money sent from one person to another.
    if data.get("type") != "p2p":
        return {"decision": "allow"}

    payer = data["payer"]["msisdn"]   # who is sending
    payee = data["payee"]["msisdn"]   # who is receiving
    history = ctx.store.get(payer, {})  # {number they paid: how many times}
    times = history.get(payee, 0)

    # 1. LEARN: a payment just went through, so remember it.
    if point == "events" and data.get("event") == "payment.completed":
        history[payee] = times + 1
        ctx.store.set(payer, history)
        print(f"Learned: {payer} has paid {payee} {times + 1} time(s)")
        return {"decision": "allow"}

    # 2. CHECK: a payment is about to go through. Is the number familiar?
    if point == "payment.authorize" and times < FAMILIAR_AFTER:
        return {
            "decision": "warn",
            "message": f"You have paid {payee} only {times} time(s) before. Is this the right number?",
        }

    return {"decision": "allow"}
`,
    },
  },
  {
    id: "swap-hold",
    label: "Pause payments after a SIM swap",
    about: "Holds large payments from a wallet whose SIM was replaced in the last two days, a common sign of account takeover. Plug it into a network at payment.authorize.",
    plugAt: ["payment.authorize"],
    source: {
      javascript: `// SIM-SWAP PAUSE: hold large payments soon after a SIM was replaced (a sign of account takeover).
//
// Plug it in on a network at payment.authorize.
//
// The sandbox asks this one function a question:   decide(point, data, ctx)
//
//     point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
//                                 "events"            = something has just happened
//     data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
//                                 (the Test tab shows a real example for every step)
//     ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
//                                 ctx.at is the time now in the sandbox
//
// and you answer with one of:
//     { decision: "allow" }
//     { decision: "warn",   message: "..." }       the customer sees it, then Continue or Cancel
//     { decision: "delay",  minutes: 60, message: "..." }
//     { decision: "reject", message: "..." }
//
// console.log() shows under Output.

const PAUSE_HOURS = 48; // how long after a SIM swap to be careful
const LARGE = 200; // cedis: smaller payments are let through

export function decide(point, data, ctx) {
  // We only look at payments about to go through.
  if (point !== "payment.authorize") return { decision: "allow" };

  const swapped = data.payer.lastSimSwapAt; // when the payer's SIM was last replaced, or null
  if (!swapped || data.amount < LARGE) return { decision: "allow" };

  // 1. How long ago was the swap? (ctx.at is the time now in the sandbox)
  const hours = (Date.parse(ctx.at) - Date.parse(swapped)) / 3_600_000;

  // 2. Recent swap and a large payment: someone may have taken over the number. Hold the money.
  if (hours < PAUSE_HOURS) {
    console.log(\`Pausing GHS \${data.amount}: SIM swapped \${Math.round(hours)} hours ago\`);
    return { decision: "delay", minutes: 60, message: "Your SIM was recently replaced. For your protection, this payment is paused for an hour." };
  }

  return { decision: "allow" };
}
`,
      python: `"""SIM-SWAP PAUSE: hold large payments soon after a SIM was replaced (a sign of account takeover).

Plug it in on a network at payment.authorize.

The sandbox asks this one function a question:   decide(point, data, ctx)

    point  WHICH MOMENT it is:  "payment.authorize" = a payment is about to go through
                                "events"            = something has just happened
    data   THE FACTS about it:  amount, who is paying (payer), who is being paid (payee) ...
                                (the Test tab shows a real example for every step)
    ctx    A TOOLBOX:           ctx.store.get(key) / ctx.store.set(key, value) remember things,
                                ctx.at is the time now in the sandbox

and you answer with one of:
    {"decision": "allow"}
    {"decision": "warn",   "message": "..."}       the customer sees it, then Continue or Cancel
    {"decision": "delay",  "minutes": 60, "message": "..."}
    {"decision": "reject", "message": "..."}

print() shows under Output.
"""

from datetime import datetime

PAUSE_HOURS = 48   # how long after a SIM swap to be careful
LARGE = 200        # cedis: smaller payments are let through


def decide(point, data, ctx):
    # We only look at payments about to go through.
    if point != "payment.authorize":
        return {"decision": "allow"}

    swapped = data["payer"].get("lastSimSwapAt")   # when the payer's SIM was last replaced, or None
    if not swapped or data["amount"] < LARGE:
        return {"decision": "allow"}

    # 1. How long ago was the swap? (ctx.at is the time now in the sandbox)
    hours = (datetime.fromisoformat(ctx.at) - datetime.fromisoformat(swapped)).total_seconds() / 3600

    # 2. Recent swap and a large payment: someone may have taken over the number. Hold the money.
    if hours < PAUSE_HOURS:
        print(f"Pausing GHS {data['amount']}: SIM swapped {hours:.0f} hours ago")
        return {"decision": "delay", "minutes": 60, "message": "Your SIM was recently replaced. For your protection, this payment is paused for an hour."}

    return {"decision": "allow"}
`,
    },
  },
  {
    id: "fraud-shield",
    label: "Fraud shield",
    about: "Several rules at once: holds money after a SIM swap or when new wallets move large sums, warns on calls and new payees, labels scam texts and strange callers. Stopped 37 of 40 incidents in the Fraud console. Plug it into each network at payment.authorize, sms.deliver, call.connect and payment.request.",
    plugAt: ["payment.authorize", "sms.deliver", "call.connect", "payment.request"],
    source: {
      javascript: `// Fraud shield: one plug-in for several steps. Tested against every kind of fraud in the Fraud console.
// Plug it into each network at: payment.authorize, sms.deliver, call.connect and payment.request.
// A warning only helps when the victim is the one paying; where the fraudster holds the wallet, money is held instead.
const HOUR = 3600 * 1000;
const SCAM_WORDS = /(won|winner|prize|promo|reward|claim|reversed|reverse|by mistake|wrong number|send (it )?back|refund|urgent|new number|my phone (is )?(spoilt|lost)|pin|verify your|blocked|suspended|customer (care|service))/i;

const hoursSince = (iso, now) => (iso ? (now - Date.parse(iso)) / HOUR : Infinity);

export function decide(point, data, ctx) {
  const now = ctx.at ? Date.parse(ctx.at) : Date.now();

  if (point === "sms.deliver") {
    // A first text from a stranger, in the words scammers use: label it.
    if (data.fromType === "person" && !data.textsBetweenThemBefore && SCAM_WORDS.test(data.text ?? "")) {
      return { decision: "warn", message: "Possible scam: a stranger's message about money. Never send money or your PIN because of a text." };
    }
    return { decision: "allow" };
  }

  if (point === "call.connect") {
    // A first call from a brand-new SIM, or from a number ringing many people: warn on the call screen.
    const newSim = hoursSince(data.callerSimRegisteredAt, now) < 72;
    if (!data.callsBetweenThemBefore && (newSim || (data.numbersTheCallerHasRungToday ?? 0) >= 5)) {
      return { decision: "warn", message: "Suspected fraud: unknown caller" };
    }
    return { decision: "allow" };
  }

  if (point === "payment.request") {
    // A stranger asking the customer to approve a payment: refuse it.
    if (data.requester?.walletType === "person" && !data.customerHasPaidThisRequesterBefore) {
      return { decision: "reject", message: "Payment requests from people you have never paid are blocked. Never approve a prompt to 'receive' money." };
    }
    // Agents ask for approval all day long (every cash-out); only a shop asking this often is odd.
    if (data.requester?.walletType === "merchant" && (data.requestsFromThisRequesterToday ?? 0) >= 5) return { decision: "reject", message: "Too many payment requests from this business today." };
    return { decision: "allow" };
  }

  if (point === "payment.authorize") {
    const payer = data.payer ?? {};
    const payee = data.payee ?? {};
    const first = !data.paymentsToThisPayeeBefore;
    // 1. Money leaving soon after the SIM was replaced: the classic account takeover.
    if (hoursSince(payer.lastSimSwapAt, now) < 48 && data.amount >= 50) {
      return { decision: "delay", minutes: 120, message: "Your SIM was replaced recently. For your protection, payments are paused for two hours." };
    }
    // 2. Paying someone new while on a call: someone may be talking the customer into it.
    if (payer.onCallWith && first) {
      return { decision: "warn", message: "Are you on a call with someone asking you to send money? Fraudsters do this. Hang up and check first." };
    }
    // 3. Many payments in a day that together empty the wallet: splitting to stay under limits.
    if ((payer.paymentsInLast24Hours ?? 0) >= 3 && first && (payer.amountSentInLast24Hours ?? 0) + data.amount > 0.5 * ((payer.balance ?? 0) + (payer.amountSentInLast24Hours ?? 0))) {
      return { decision: "delay", minutes: 60, message: "Many payments from your wallet today. For your protection, this one is paused for an hour." };
    }
    // 4. Large sums leaving a wallet that is itself only days old: how mules move stolen money on. A warning
    //    is no use here (the person paying is the fraudster), so the money is held instead.
    if (data.amount >= 200 && hoursSince(payer.walletOpenedAt, now) < 3 * 24 && first) {
      return { decision: "delay", minutes: 180, message: "New wallets cannot send large sums to new contacts straight away. Try again later." };
    }
    // 5. Most of a wallet going to a brand-new wallet in one go: a thief emptying a stolen phone.
    if (first && (payer.balance ?? 0) >= 200 && data.amount >= 0.8 * payer.balance && hoursSince(payee.walletOpenedAt, now) < 7 * 24) {
      return { decision: "delay", minutes: 60, message: "This payment would empty your wallet into a brand-new one. For your protection, it is paused for an hour." };
    }
    // 6. A first, sizeable payment to a wallet opened only days ago.
    if (first && data.amount >= 100 && hoursSince(payee.walletOpenedAt, now) < 7 * 24) {
      return { decision: "warn", message: \`You have never paid \${payee.name ?? "this number"}, and their wallet is new. Check it is genuine before you send.\` };
    }
    return { decision: "allow" };
  }

  return { decision: "allow" };
}
`,
      python: `# Fraud shield: one plug-in for several steps. Tested against every kind of fraud in the Fraud console.
# Plug it into each network at: payment.authorize, sms.deliver, call.connect and payment.request.
# A warning only helps when the victim is the one paying; where the fraudster holds the wallet, money is held instead.
import re
from datetime import datetime, timezone

SCAM_WORDS = re.compile(r"(won|winner|prize|promo|reward|claim|reversed|reverse|by mistake|wrong number|send (it )?back|refund|urgent|new number|my phone (is )?(spoilt|lost)|pin|verify your|blocked|suspended|customer (care|service))", re.I)


def when(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")) if iso else None


def hours_since(iso, now):
    t = when(iso)
    return (now - t).total_seconds() / 3600 if t else float("inf")


def decide(point, data, ctx):
    # ctx.at is the time in the world now: the Fraud console plays incidents at times of its own.
    now = when(ctx.at) or datetime.now(timezone.utc)

    if point == "sms.deliver":
        # A first text from a stranger, in the words scammers use: label it.
        if data.get("fromType") == "person" and not data.get("textsBetweenThemBefore") and SCAM_WORDS.search(data.get("text") or ""):
            return {"decision": "warn", "message": "Possible scam: a stranger's message about money. Never send money or your PIN because of a text."}
        return {"decision": "allow"}

    if point == "call.connect":
        # A first call from a brand-new SIM, or from a number ringing many people: warn on the call screen.
        new_sim = hours_since(data.get("callerSimRegisteredAt"), now) < 72
        if not data.get("callsBetweenThemBefore") and (new_sim or (data.get("numbersTheCallerHasRungToday") or 0) >= 5):
            return {"decision": "warn", "message": "Suspected fraud: unknown caller"}
        return {"decision": "allow"}

    if point == "payment.request":
        requester = data.get("requester") or {}
        # A stranger asking the customer to approve a payment: refuse it.
        if requester.get("walletType") == "person" and not data.get("customerHasPaidThisRequesterBefore"):
            return {"decision": "reject", "message": "Payment requests from people you have never paid are blocked. Never approve a prompt to 'receive' money."}
        # Agents ask for approval all day long (every cash-out); only a shop asking this often is odd.
        if requester.get("walletType") == "merchant" and (data.get("requestsFromThisRequesterToday") or 0) >= 5:
            return {"decision": "reject", "message": "Too many payment requests from this business today."}
        return {"decision": "allow"}

    if point == "payment.authorize":
        payer, payee = data.get("payer") or {}, data.get("payee") or {}
        amount = data.get("amount") or 0
        first = not data.get("paymentsToThisPayeeBefore")
        balance = payer.get("balance") or 0
        sent_today = payer.get("amountSentInLast24Hours") or 0
        # 1. Money leaving soon after the SIM was replaced: the classic account takeover.
        if hours_since(payer.get("lastSimSwapAt"), now) < 48 and amount >= 50:
            return {"decision": "delay", "minutes": 120, "message": "Your SIM was replaced recently. For your protection, payments are paused for two hours."}
        # 2. Paying someone new while on a call: someone may be talking the customer into it.
        if payer.get("onCallWith") and first:
            return {"decision": "warn", "message": "Are you on a call with someone asking you to send money? Fraudsters do this. Hang up and check first."}
        # 3. Many payments in a day that together empty the wallet: splitting to stay under limits.
        if (payer.get("paymentsInLast24Hours") or 0) >= 3 and first and sent_today + amount > 0.5 * (balance + sent_today):
            return {"decision": "delay", "minutes": 60, "message": "Many payments from your wallet today. For your protection, this one is paused for an hour."}
        # 4. Large sums leaving a wallet that is itself only days old: how mules move stolen money on.
        if amount >= 200 and hours_since(payer.get("walletOpenedAt"), now) < 3 * 24 and first:
            return {"decision": "delay", "minutes": 180, "message": "New wallets cannot send large sums to new contacts straight away. Try again later."}
        # 5. Most of a wallet going to a brand-new wallet in one go: a thief emptying a stolen phone.
        if first and balance >= 200 and amount >= 0.8 * balance and hours_since(payee.get("walletOpenedAt"), now) < 7 * 24:
            return {"decision": "delay", "minutes": 60, "message": "This payment would empty your wallet into a brand-new one. For your protection, it is paused for an hour."}
        # 6. A first, sizeable payment to a wallet opened only days ago.
        if first and amount >= 100 and hours_since(payee.get("walletOpenedAt"), now) < 7 * 24:
            name = payee.get("name") or "this number"
            return {"decision": "warn", "message": f"You have never paid {name}, and their wallet is new. Check it is genuine before you send."}
        return {"decision": "allow"}

    return {"decision": "allow"}
`,
    },
  },
];
