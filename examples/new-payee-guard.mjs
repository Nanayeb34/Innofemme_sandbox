// New-payee guard: an outside API a network plugs into its payment step.
// (JavaScript, Node.js 18 or later, nothing to install.)
//
// It learns who each customer usually sends money to, and when a customer is about to send money to a number
// they have never paid, or have paid only rarely, it asks the network to warn them first. The customer sees the
// warning on their phone and chooses to continue or cancel.
//
// It keeps its own record. Plug it into a network TWICE, at the same address:
//   1. "events": the network tells it about every completed payment, which is how it learns who pays whom.
//   2. "payment.authorize": the network asks it before each payment goes through, and it answers "allow" or "warn".
//
// Run it:      node new-payee-guard.mjs                   (listens on port 4020; --port 5000 for another)
//              node new-payee-guard.mjs --familiar-after 3 (how many past payments make a number familiar; default 2)
// Plug it in:  the network's back office > Plug-ins > "Plug in an API", once for each step above, with the address
//              http://localhost:4020/ when the sandbox runs on this machine.
// See it:      open http://localhost:4020/ in a browser: every customer and the numbers they have paid.
// Start over:  delete known-payees.json, which sits next to this file.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", process.env.PORT ?? 4020));
const familiarAfter = Math.max(1, Number(arg("familiar-after", 2)));
const file = fileURLToPath(new URL("./known-payees.json", import.meta.url));

// { "<world>|<network>|<payer number>": { "<payee number>": { name, payments, lastAt } } }
let known = {};
try {
  known = JSON.parse(readFileSync(file, "utf8"));
} catch {
  known = {};
}
const save = () => writeFileSync(file, JSON.stringify(known, null, 2));

/** Only money sent to another person's wallet is checked: shops, bills and banks are left alone. */
const isPersonToPerson = (d) => d.type === "p2p" && d.payee?.msisdn && d.payer?.msisdn;
const keyOf = (world, d) => `${world}|${d.payer.network}|${d.payer.msisdn}`;

function learn(world, d) {
  if (d.event !== "payment.completed" || !isPersonToPerson(d)) return;
  const mine = (known[keyOf(world, d)] ??= {});
  const p = (mine[d.payee.msisdn] ??= { name: d.payee.name ?? null, payments: 0, lastAt: null });
  p.payments += 1;
  p.name = d.payee.name ?? p.name;
  p.lastAt = new Date().toISOString();
  save();
  console.log(`  learned: ${d.payer.msisdn} has now paid ${d.payee.msisdn} ${p.payments} time(s)`);
}

function check(world, d) {
  if (!isPersonToPerson(d)) return { decision: "allow" };
  const before = known[keyOf(world, d)]?.[d.payee.msisdn]?.payments ?? 0;
  if (before >= familiarAfter) return { decision: "allow" };
  const who = `${d.payee.name ? `${d.payee.name} ` : ""}${d.payee.msisdn}`;
  // A phone screen shows about 180 characters, so the warning is kept short.
  const message =
    before === 0
      ? `Caution: you have never sent money to ${who}. Fraudsters pose as family or agents. Check the number is genuine.`
      : `Caution: you rarely send money to ${who} (${before} time${before === 1 ? "" : "s"} before). Check the number is genuine.`;
  return { decision: "warn", message };
}

function decide(point, world, data) {
  if (point === "events") {
    learn(world, data);
    return { decision: "allow" };
  }
  if (point === "payment.authorize") return check(world, data);
  return { decision: "allow" };
}

createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ familiarAfter, known }, null, 2));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let answer = { decision: "allow" };
    try {
      const { point, institution, world, data } = JSON.parse(body);
      answer = decide(point, world, data ?? {});
      const what = point === "events" ? data?.event : `${data?.type} GHS ${data?.amount} ${data?.payer?.msisdn} -> ${data?.payee?.msisdn ?? "?"}`;
      console.log(new Date().toISOString(), institution, point, what, point === "events" ? "" : `-> ${answer.decision}`);
    } catch (e) {
      console.error("Could not read the request:", e.message);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
}).listen(port, () => console.log(`New-payee guard listening on port ${port}. A number is familiar after ${familiarAfter} payment(s).`));
