// A starting point for an API that a network, a bank or the national switch can plug into its own system.
// It says "allow" to everything and prints what it was sent. Put your own logic where marked.
//
// Run it:      node examples/starter-api.mjs            (listens on port 4010)
// Plug it in:  open an institution's console > Plug-ins > "Plug in an API", address http://localhost:4010/
//
// You receive:  { "point": "...", "institution": "...", "world": "...", "at": "...", "data": { ... } }
// You answer:   { "decision": "allow" }
//               { "decision": "reject", "message": "shown to the customer" }
//               { "decision": "warn",   "message": "shown first; the customer chooses whether to continue" }
//               { "decision": "delay",  "minutes": 10, "message": "..." }
// Which answers a step accepts, and what "data" holds, is in the API reference inside the sandbox (section 7).

import { createServer } from "node:http";

function decide(point, institution, data) {
  // Your logic goes here. For now it only shows that a question arrived.
  console.log(new Date().toISOString(), institution, point, JSON.stringify(data));
  return { decision: "allow" };
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let answer = { decision: "allow" };
    try {
      const { point, institution, data } = JSON.parse(body);
      answer = decide(point, institution, data);
      console.log("  ->", JSON.stringify(answer));
    } catch (e) {
      console.error("Could not read the request:", e.message);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
}).listen(process.env.PORT ?? 4010, () => console.log("Listening on port", process.env.PORT ?? 4010));
