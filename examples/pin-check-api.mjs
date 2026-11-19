// An example of a product that is an API: a weak-PIN checker a network can plug into its own system.
//
// Run it:      node examples/pin-check-api.mjs          (listens on port 4010)
// Plug it in:  open a network's back office > Plug-ins > "Plug in an API"
//              Name: Weak PIN checker
//              Ask it when: A customer chooses or changes a wallet PIN
//              Address: http://localhost:4010/         (or its public address if it runs elsewhere)
// Try it:      on the customer phone, dial the network's mobile money code and register a wallet
//              using the last four digits of the number as the PIN.
//
// The network sends:   { "point": "pin.set", "institution": "mtn", "data": { "msisdn": "0241234567", "pin": "4567", "customer": { "dateOfBirth": "1994-03-12", ... } } }
// This API answers:    { "decision": "allow" }   or   { "decision": "reject", "message": "shown to the customer" }

import { createServer } from "node:http";

function problemWith(pin, msisdn, dateOfBirth) {
  if (msisdn.endsWith(pin)) return "That PIN is the end of your phone number. Anyone who knows your number could guess it.";
  if (/^(\d)\1{3}$/.test(pin)) return "That PIN is one digit repeated. Choose one that is harder to guess.";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "That PIN is a simple sequence. Choose one that is harder to guess.";
  const [year, month, day] = String(dateOfBirth ?? "").split("-");
  if (year && [year, day + month, month + day].includes(pin)) return "That PIN is your date of birth. Choose one that is harder to guess.";
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let answer = { decision: "allow" };
    try {
      const { point, data } = JSON.parse(body);
      const problem = point === "pin.set" ? problemWith(String(data.pin), String(data.msisdn), data.customer?.dateOfBirth) : undefined;
      if (problem) answer = { decision: "reject", message: problem };
      console.log(point, data.msisdn, "->", answer.decision);
    } catch {
      // Anything this API does not understand is allowed through.
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
}).listen(process.env.PORT ?? 4010, () => console.log("Weak PIN checker listening on port", process.env.PORT ?? 4010));
