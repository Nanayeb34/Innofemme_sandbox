// The bridge: lets the sandbox reach an API running on this computer.
// (JavaScript. The same thing in Python is bridge.py.)
//
// A sandbox on the internet cannot call http://localhost on your laptop. This program calls the sandbox
// instead and waits; whatever the sandbox has for your API arrives on that call, is passed to your API
// here, and the answer is sent back. Your API stays an ordinary API: nothing in it changes.
// It needs nothing installed beyond Node.js 18 or later.
//
// 1. Start your API on this computer, for example:   node plugin-api.mjs        (port 4010)
// 2. Start the bridge beside it:
//      node bridge.mjs --sandbox https://…/api/w/your-team --key YOUR-TEAM-KEY
//    The two values are the "Base URL" and "Team key" at the top of your team's documentation page.
//    --to http://localhost:5000   if your API is somewhere other than http://localhost:4010
//    --name ama                   to call this bridge something other than "laptop" (one name per laptop)
// 3. Wherever the sandbox asks for your API's address, type:   bridge://laptop
//    A path is passed on too: bridge://laptop/check reaches http://localhost:4010/check
//
// Leave it running while you work. If it stops, the sandbox treats your API as not answering.

import { randomUUID } from "node:crypto";

// Settings can be given as arguments (--name value), which works on every system, or as environment variables.
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])));
const SANDBOX = args.sandbox ?? process.env.SANDBOX;
const TEAM_KEY = args.key ?? process.env.TEAM_KEY;
const TO = args.to ?? process.env.TO ?? "http://localhost:4010";
const NAME = args.name ?? process.env.NAME ?? "laptop";
if (!SANDBOX || !TEAM_KEY) {
  console.error("Usage: node bridge.mjs --sandbox https://…/api/w/your-team --key YOUR-TEAM-KEY   (see the top of this file)");
  process.exit(1);
}
const sandbox = `${SANDBOX.replace(/\/$/, "")}/bridge`;
const api = TO.replace(/\/$/, "");
const session = randomUUID(); // tells this run of the bridge from an earlier one
const clock = () => new Date().toTimeString().slice(0, 8);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tell = (body, ms) =>
  fetch(sandbox, { method: "POST", headers: { "x-team-key": TEAM_KEY, "content-type": "application/json" }, body: JSON.stringify({ name: NAME, session, ...body }), signal: AbortSignal.timeout(ms) });

/** Passes one request to the API on this computer and sends its answer back. */
async function pass(request) {
  const started = Date.now();
  let answer;
  try {
    const res = await fetch(api + request.path, { method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(10_000) });
    answer = { status: res.status, body: await res.text() };
    console.log(`${clock()}  ${request.method} ${request.path}  ->  ${res.status} in ${Date.now() - started} ms`);
  } catch (e) {
    const slow = e.name === "TimeoutError";
    answer = { error: slow ? `The API at ${api} took more than 10 seconds` : `Nothing is answering at ${api}: is your API running?` };
    console.log(`${clock()}  ${request.method} ${request.path}  ->  ${answer.error}`);
  }
  try {
    const sent = await (await tell({ action: "reply", id: request.id, ...answer }, 10_000)).json();
    if (sent.ok === false && sent.reason) console.log(`          ${sent.reason}`);
  } catch {
    console.log("          Could not send that answer back to the sandbox.");
  }
}

let state = "starting";
for (;;) {
  try {
    const res = await tell({ action: "poll", to: api }, 40_000);
    const got = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`The sandbox refused the bridge (${res.status}): ${got.error ?? "check --sandbox and --key"}`);
      if (res.status < 500) process.exit(1);
      throw new Error("try again");
    }
    if (got.replaced) {
      console.log(`Another bridge has connected as "${NAME}", so this one has stopped. Give each laptop its own NAME to run both.`);
      process.exit(0);
    }
    if (state !== "connected") {
      console.log(`Connected to the sandbox as "${NAME}". Passing requests on to ${api}`);
      console.log(`Wherever the sandbox asks for your API's address, type:  bridge://${NAME}`);
      state = "connected";
    }
    for (const request of got.requests ?? []) void pass(request);
  } catch {
    if (state !== "lost") console.log("Cannot reach the sandbox. Trying again every 2 seconds…");
    state = "lost";
    await sleep(2000);
  }
}
