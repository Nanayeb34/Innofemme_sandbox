// Starter kit: an API that a network, a bank or the national switch plugs into its own system.
// (JavaScript. The same thing in Python is plugin_api.py.)
//
// It says "allow" to everything and prints what it was sent. Put your own logic in decide().
// It needs nothing installed beyond Node.js 18 or later.
//
// Run it:      node plugin-api.mjs                      (listens on port 4010; node plugin-api.mjs --port 5000 for another)
// Plug it in:  open an institution's console > Plug-ins > "Plug in an API", and give this API's address.
//              With the sandbox on your own machine that is http://localhost:4010/
//              With a sandbox shared by every team, run the bridge beside this API (bridge.py or bridge.mjs)
//              and give the address bridge://laptop
// Try it:      the Plug-ins tab has a "Send a test" button, and shows every question asked and what you answered.
//
// You receive:  { "point": "...", "institution": "...", "world": "...", "at": "...", "data": { ... } }
// You answer:   { "decision": "allow" }
//               { "decision": "reject", "message": "shown to the customer" }
//               { "decision": "warn",   "message": "shown first; the customer chooses whether to continue" }
//               { "decision": "delay",  "minutes": 10, "message": "..." }
// Which answers each step accepts, and what "data" holds at each step, is in the documentation (section 7).
// You have 2 seconds to answer unless the institution gave you longer.
//
// The Fraud API can also send fraud incidents straight to this address, in the same format (section 13).

import { createServer } from "node:http";

const at = process.argv.indexOf("--port");
const port = Number(at > 0 ? process.argv[at + 1] : (process.env.PORT ?? 4010));

function decide(point, institution, data) {
  // Your logic goes here. For now it only shows that a question arrived.
  console.log(new Date().toISOString(), institution, point, JSON.stringify(data));
  return { decision: "allow" };
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let answer = { decision: "allow" };
    try {
      const { point, institution, data } = JSON.parse(body);
      // decide() may also be async, for example to ask the sandbox something before answering.
      answer = await decide(point, institution, data ?? {});
      console.log("  ->", JSON.stringify(answer));
    } catch (e) {
      console.error("Could not read the request:", e.message);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
}).listen(port, () => console.log("Listening on port", port));
