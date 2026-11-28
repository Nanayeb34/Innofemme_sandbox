// Starter kit: an application of your own that uses what an institution gives an outside company.
// (JavaScript. The same thing in Python is app.py.)
//
// It signs in to one network with the credentials that network issued, then makes one call of each kind
// and prints what came back. Nothing here is a product: it shows how to connect. Keep what you need.
// It needs nothing installed beyond Node.js 18 or later.
//
// Before you run it:
//   1. Open the network's console (for example MTN) > API partners, and give a company access.
//      To collect payments, tie it to one of the network's merchants. You get a client ID and an API key.
//   2. Pick a customer's number on that network (the Phone simulator lists them).
//
// Run it:
//   node app.mjs --sandbox https://…/api/w/your-team --client-id … --api-key … --number 024…
//   Add --amount 5 to also ask that customer for a payment of GHS 5, and wait for their answer.
//   Add --network telecel or --network at for the other networks (default mtn).
//
// --sandbox is the "Base URL" shown at the top of your team's documentation page.

import { randomUUID } from "node:crypto";

// Settings can be given as arguments (--name value), which works on every system, or as environment variables.
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])));
const SANDBOX = args.sandbox ?? process.env.SANDBOX;
const CLIENT_ID = args["client-id"] ?? process.env.CLIENT_ID;
const API_KEY = args["api-key"] ?? process.env.API_KEY;
const NUMBER = args.number ?? process.env.NUMBER;
const AMOUNT = args.amount ?? process.env.AMOUNT;
const NETWORK = args.network ?? process.env.NETWORK ?? "mtn";
if (!SANDBOX || !CLIENT_ID || !API_KEY || !NUMBER) {
  console.error("Usage: node app.mjs --sandbox https://…/api/w/your-team --client-id … --api-key … --number 024…   (see the top of this file)");
  process.exit(1);
}
const network = `${SANDBOX.replace(/\/$/, "")}/network/${NETWORK}`;
const momo = `${SANDBOX.replace(/\/$/, "")}/momo/${NETWORK}`;

/** One request. Returns the status and whatever came back. */
async function call(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, ok: res.ok, data };
}
const show = (what, r) => console.log(`\n${what}\n  ${r.status}`, typeof r.data === "string" ? r.data : JSON.stringify(r.data));

// 1. Swap the client ID and API key for a token. It works on this network's APIs for an hour.
const signIn = await call("POST", `${network}/token`, { headers: { authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${API_KEY}`).toString("base64") } });
show("Signing in", { ...signIn, data: signIn.ok ? { ...signIn.data, access_token: "(received)" } : signIn.data });
if (!signIn.ok) process.exit(1);
const auth = { authorization: `Bearer ${signIn.data.access_token}` };

// 2. Network API: is the number in service, and was its SIM replaced lately? (A network never gives out the name.)
show("Is the number in service", await call("GET", `${network}/v1/subscribers/${NUMBER}`, { headers: auth }));
show("Was the SIM replaced in the last 10 days?", await call("POST", `${network}/v1/sim-swap/check`, { headers: auth, body: { phoneNumber: NUMBER, maxAge: 240 } }));

// 3. Mobile money API: the name on the wallet.
show("The name on the wallet", await call("GET", `${momo}/collection/v1_0/accountholder/msisdn/${NUMBER}/basicuserinfo`, { headers: auth }));

// 4. Mobile money API: ask the customer for a payment, then wait for their answer.
if (AMOUNT) {
  const reference = randomUUID(); // your own reference for this request
  const asked = await call("POST", `${momo}/collection/v1_0/requesttopay`, {
    headers: { ...auth, "x-reference-id": reference },
    body: { amount: String(AMOUNT), currency: "GHS", externalId: "order-1", payer: { partyIdType: "MSISDN", partyId: NUMBER }, payerMessage: "Test payment", payeeNote: "Starter kit" },
  });
  show(`Asking ${NUMBER} for GHS ${AMOUNT}`, asked);
  if (asked.status === 202) {
    console.log("\nThe customer now approves or refuses on their phone. Open that number in the Phone simulator and dial the wallet code.");
    for (let i = 0; i < 60; i++) {
      const r = await call("GET", `${momo}/collection/v1_0/requesttopay/${reference}`, { headers: auth });
      if (r.data?.status !== "PENDING") {
        show("Their answer", r);
        break;
      }
      process.stdout.write(".");
      await new Promise((done) => setTimeout(done, 2000));
    }
  }
}
