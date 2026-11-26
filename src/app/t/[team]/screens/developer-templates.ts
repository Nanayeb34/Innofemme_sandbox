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

const JS_HEAD = `// The institution you plug this into calls decide() at the step you choose, and acts on the answer.
//
//   point  the step: "payment.authorize", "sim.swap", ... or "events" for things that have already happened
//   data   what is about to happen. "Try it" below shows a real example for any step.
//   ctx    ctx.institution, ctx.world, ctx.log(...), and ctx.store: get(key), set(key, value), delete(key),
//          which is kept between questions and restarts
//
// Answer with { decision: "allow" }, or one of these where the step accepts it:
//   { decision: "warn",   message: "shown to the customer, who chooses whether to continue" }
//   { decision: "delay",  minutes: 10, message: "..." }
//   { decision: "reject", message: "shown to the customer" }
//
// Node's built-in modules only. console.log() appears under Output. You have about 2 seconds to answer.
`;

const PY_HEAD = `# The institution you plug this into calls decide() at the step you choose, and acts on the answer.
#
#   point  the step: "payment.authorize", "sim.swap", ... or "events" for things that have already happened
#   data   what is about to happen, as a dict. "Try it" below shows a real example for any step.
#   ctx    ctx.institution, ctx.world, ctx.log(...), and ctx.store: get(key, default), set(key, value),
#          delete(key), which is kept between questions and restarts
#
# Answer with {"decision": "allow"}, or one of these where the step accepts it:
#   {"decision": "warn",   "message": "shown to the customer, who chooses whether to continue"}
#   {"decision": "delay",  "minutes": 10, "message": "..."}
#   {"decision": "reject", "message": "shown to the customer"}
#
# Python's standard library only. print() appears under Output. You have about 2 seconds to answer.
`;

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    about: "Allows everything and shows each question under Output. Start here and add your own rules.",
    plugAt: [],
    source: {
      javascript: `${JS_HEAD}
export function decide(point, data, ctx) {
  console.log("Asked about", point);
  return { decision: "allow" };
}
`,
      python: `${PY_HEAD}

def decide(point, data, ctx):
    print("Asked about", point)
    return {"decision": "allow"}
`,
    },
  },
  {
    id: "new-payee",
    label: "New-payee warning",
    about: "Learns who each customer pays, and warns before money goes to a number they have rarely or never paid. Plug it into a network at Events and at payment.authorize.",
    plugAt: ["events", "payment.authorize"],
    source: {
      javascript: `${JS_HEAD}
// A number counts as familiar once the customer has paid it this many times.
const FAMILIAR_AFTER = 2;

export function decide(point, data, ctx) {
  // Only money sent to another person's wallet is checked.
  if (data.type !== "p2p" || !data.payer?.msisdn || !data.payee?.msisdn) return { decision: "allow" };
  const key = \`\${data.payer.network}:\${data.payer.msisdn}\`;
  const paid = ctx.store.get(key) ?? {};

  // Learn from every completed payment.
  if (point === "events") {
    if (data.event === "payment.completed") {
      paid[data.payee.msisdn] = (paid[data.payee.msisdn] ?? 0) + 1;
      ctx.store.set(key, paid);
      console.log(\`\${data.payer.msisdn} has paid \${data.payee.msisdn} \${paid[data.payee.msisdn]} time(s)\`);
    }
    return { decision: "allow" };
  }

  if (point !== "payment.authorize") return { decision: "allow" };
  const before = paid[data.payee.msisdn] ?? 0;
  if (before >= FAMILIAR_AFTER) return { decision: "allow" };
  const who = \`\${data.payee.name ?? ""} \${data.payee.msisdn}\`.trim();
  return {
    decision: "warn",
    message: before === 0
      ? \`Caution: you have never sent money to \${who}. Fraudsters pose as family or agents. Check the number is genuine.\`
      : \`Caution: you rarely send money to \${who} (\${before} time\${before === 1 ? "" : "s"} before). Check the number is genuine.\`,
  };
}
`,
      python: `${PY_HEAD}
# A number counts as familiar once the customer has paid it this many times.
FAMILIAR_AFTER = 2


def decide(point, data, ctx):
    payer, payee = data.get("payer") or {}, data.get("payee") or {}
    # Only money sent to another person's wallet is checked.
    if data.get("type") != "p2p" or not payer.get("msisdn") or not payee.get("msisdn"):
        return {"decision": "allow"}
    key = f"{payer.get('network')}:{payer['msisdn']}"
    paid = ctx.store.get(key, {})

    # Learn from every completed payment.
    if point == "events":
        if data.get("event") == "payment.completed":
            paid[payee["msisdn"]] = paid.get(payee["msisdn"], 0) + 1
            ctx.store.set(key, paid)
            print(f"{payer['msisdn']} has paid {payee['msisdn']} {paid[payee['msisdn']]} time(s)")
        return {"decision": "allow"}

    if point != "payment.authorize":
        return {"decision": "allow"}
    before = paid.get(payee["msisdn"], 0)
    if before >= FAMILIAR_AFTER:
        return {"decision": "allow"}
    who = f"{payee.get('name') or ''} {payee['msisdn']}".strip()
    if before == 0:
        message = f"Caution: you have never sent money to {who}. Fraudsters pose as family or agents. Check the number is genuine."
    else:
        message = f"Caution: you rarely send money to {who} ({before} time{'' if before == 1 else 's'} before). Check the number is genuine."
    return {"decision": "warn", "message": message}
`,
    },
  },
  {
    id: "swap-hold",
    label: "Pause payments after a SIM swap",
    about: "Delays large payments from a wallet whose SIM was replaced in the last 24 hours, a common sign of account takeover. Plug it into a network at payment.authorize.",
    plugAt: ["payment.authorize"],
    source: {
      javascript: `${JS_HEAD}
const HOURS = 24;
const LARGE = 200; // cedis

export function decide(point, data, ctx) {
  if (point !== "payment.authorize") return { decision: "allow" };
  const swapped = data.payer?.lastSimSwapAt ? new Date(data.payer.lastSimSwapAt).getTime() : 0;
  const recent = swapped && Date.now() - swapped < HOURS * 3600 * 1000;
  if (recent && data.amount >= LARGE) {
    console.log(\`Delaying GHS \${data.amount} from \${data.payer.msisdn}: SIM swapped at \${data.payer.lastSimSwapAt}\`);
    return { decision: "delay", minutes: 60, message: "Your SIM was recently replaced. For your protection, large payments are paused for an hour." };
  }
  return { decision: "allow" };
}
`,
      python: `${PY_HEAD}
from datetime import datetime, timezone

HOURS = 24
LARGE = 200  # cedis


def decide(point, data, ctx):
    if point != "payment.authorize":
        return {"decision": "allow"}
    payer = data.get("payer") or {}
    swapped = payer.get("lastSimSwapAt")
    if swapped and data.get("amount", 0) >= LARGE:
        when = datetime.fromisoformat(swapped.replace("Z", "+00:00"))
        if (datetime.now(timezone.utc) - when).total_seconds() < HOURS * 3600:
            print(f"Delaying GHS {data['amount']} from {payer.get('msisdn')}: SIM swapped at {swapped}")
            return {"decision": "delay", "minutes": 60, "message": "Your SIM was recently replaced. For your protection, large payments are paused for an hour."}
    return {"decision": "allow"}
`,
    },
  },
];
