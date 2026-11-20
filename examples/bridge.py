"""The bridge: lets the sandbox reach an API running on this computer.
(Python. The same thing in JavaScript is bridge.mjs.)

A sandbox on the internet cannot call http://localhost on your laptop. This program calls the sandbox
instead and waits; whatever the sandbox has for your API arrives on that call, is passed to your API
here, and the answer is sent back. Your API stays an ordinary API: nothing in it changes.
It needs nothing installed beyond Python 3.8 or later.

1. Start your API on this computer, for example:   python3 plugin_api.py        (port 4010)
2. Start the bridge beside it (on Windows, type python in place of python3):
     python3 bridge.py --sandbox https://…/api/w/your-team --key YOUR-TEAM-KEY
   The two values are the "Base URL" and "Team key" at the top of your team's documentation page.
   --to http://localhost:5000   if your API is somewhere other than http://localhost:4010
   --name ama                   to call this bridge something other than "laptop" (one name per laptop)
3. Wherever the sandbox asks for your API's address, type:   bridge://laptop
   A path is passed on too: bridge://laptop/check reaches http://localhost:4010/check

Leave it running while you work. If it stops, the sandbox treats your API as not answering.
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

# Settings can be given as arguments, which works on every system, or as environment variables.
parser = argparse.ArgumentParser(description="Lets the sandbox reach an API running on this computer.")
parser.add_argument("--sandbox", default=os.environ.get("SANDBOX"), help="your team's Base URL, https://…/api/w/your-team")
parser.add_argument("--key", default=os.environ.get("TEAM_KEY"), help="your team key")
parser.add_argument("--to", default=os.environ.get("TO", "http://localhost:4010"), help="where your API is (default http://localhost:4010)")
parser.add_argument("--name", default=os.environ.get("NAME", "laptop"), help='what to call this bridge (default "laptop")')
options = parser.parse_args()
SANDBOX, TEAM_KEY, NAME = options.sandbox, options.key, options.name
if not (SANDBOX and TEAM_KEY):
    sys.exit("Usage: python3 bridge.py --sandbox https://…/api/w/your-team --key YOUR-TEAM-KEY   (see the top of this file)")
sandbox = f"{SANDBOX.rstrip('/')}/bridge"
api = options.to.rstrip("/")
session = str(uuid.uuid4())  # tells this run of the bridge from an earlier one


def say(*words):
    print(*words, flush=True)


def clock():
    return time.strftime("%H:%M:%S")


def tell(body, seconds):
    """One call to the sandbox. Returns the status and what came back."""
    data = json.dumps({"name": NAME, "session": session, **body}).encode()
    request = urllib.request.Request(sandbox, data=data, headers={"x-team-key": TEAM_KEY, "content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=seconds) as res:
            status, text = res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try:
        return status, json.loads(text)
    except ValueError:
        return status, {}


def pass_on(request):
    """Passes one request to the API on this computer and sends its answer back."""
    started = time.time()
    body = request.get("body")
    try:
        outgoing = urllib.request.Request(api + request["path"], data=None if body is None else body.encode(), headers=request.get("headers") or {}, method=request["method"])
        try:
            with urllib.request.urlopen(outgoing, timeout=10) as res:
                answer = {"status": res.status, "body": res.read().decode()}
        except urllib.error.HTTPError as e:  # an answer such as 400 or 500 is still an answer
            answer = {"status": e.code, "body": e.read().decode()}
        say(f"{clock()}  {request['method']} {request['path']}  ->  {answer['status']} in {int((time.time() - started) * 1000)} ms")
    except Exception as e:
        slow = isinstance(e, socket.timeout) or isinstance(getattr(e, "reason", None), socket.timeout)
        answer = {"error": f"The API at {api} took more than 10 seconds" if slow else f"Nothing is answering at {api}: is your API running?"}
        say(f"{clock()}  {request['method']} {request['path']}  ->  {answer['error']}")
    try:
        _, sent = tell({"action": "reply", "id": request["id"], **answer}, 10)
        if sent.get("ok") is False and sent.get("reason"):
            say(f"          {sent['reason']}")
    except Exception:
        say("          Could not send that answer back to the sandbox.")


state = "starting"
while True:
    try:
        status, got = tell({"action": "poll", "to": api}, 40)
        if status != 200:
            say(f"The sandbox refused the bridge ({status}): {got.get('error', 'check --sandbox and --key')}")
            if status < 500:
                sys.exit(1)
            raise RuntimeError("try again")
        if got.get("replaced"):
            say(f'Another bridge has connected as "{NAME}", so this one has stopped. Give each laptop its own NAME to run both.')
            sys.exit(0)
        if state != "connected":
            say(f'Connected to the sandbox as "{NAME}". Passing requests on to {api}')
            say(f"Wherever the sandbox asks for your API's address, type:  bridge://{NAME}")
            state = "connected"
        for request in got.get("requests") or []:
            threading.Thread(target=pass_on, args=(request,), daemon=True).start()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception:
        if state != "lost":
            say("Cannot reach the sandbox. Trying again every 2 seconds…")
        state = "lost"
        time.sleep(2)
