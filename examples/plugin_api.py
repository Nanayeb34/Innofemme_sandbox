"""Starter kit: an API that a network, a bank or the national switch plugs into its own system.
(Python. The same thing in JavaScript is plugin-api.mjs.)

It says "allow" to everything and prints what it was sent. Put your own logic in decide().
It needs nothing installed beyond Python 3.8 or later.

Run it:      python3 plugin_api.py                    (listens on port 4010; PORT=5000 python3 plugin_api.py for another)
Plug it in:  open an institution's console > Plug-ins > "Plug in an API", and give this API's address.
             With the sandbox on your own machine that is http://localhost:4010/
             With a sandbox shared by every team, the address must be reachable from the internet.
Try it:      the Plug-ins tab has a "Send a test" button, and shows every question asked and what you answered.

You receive:  { "point": "...", "institution": "...", "world": "...", "at": "...", "data": { ... } }
You answer:   { "decision": "allow" }
              { "decision": "reject", "message": "shown to the customer" }
              { "decision": "warn",   "message": "shown first; the customer chooses whether to continue" }
              { "decision": "delay",  "minutes": 10, "message": "..." }
Which answers each step accepts, and what "data" holds at each step, is in the documentation (section 7).
You have 2 seconds to answer unless the institution gave you longer.

The Fraud API can also send fraud incidents straight to this address, in the same format (section 13).
"""

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def decide(point, institution, data):
    # Your logic goes here. For now it only shows that a question arrived.
    print(datetime.now(timezone.utc).isoformat(), institution, point, json.dumps(data), flush=True)
    return {"decision": "allow"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        answer = {"decision": "allow"}
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            answer = decide(body.get("point"), body.get("institution"), body.get("data") or {})
            print("  ->", json.dumps(answer), flush=True)
        except Exception as e:  # whatever went wrong, the institution still gets an answer
            print("Could not read the request:", e, flush=True)
        out = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):  # decide() already prints each question
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 4010))
    print("Listening on port", port, flush=True)
    ThreadingHTTPServer(("", port), Handler).serve_forever()
