"""Starter kit: an application of your own that uses what an institution gives an outside company.
(Python. The same thing in JavaScript is app.mjs.)

It signs in to one network with the credentials that network issued, then makes one call of each kind
and prints what came back. Nothing here is a product: it shows how to connect. Keep what you need.
It needs nothing installed beyond Python 3.8 or later.

Before you run it:
  1. Open the network's console (for example MTN) > API partners, and give a company access.
     To collect payments, tie it to one of the network's merchants. You get a client ID and an API key.
  2. Pick a customer's number on that network (the Phone simulator lists them).

Run it (on Windows, type python in place of python3):
  python3 app.py --sandbox https://…/api/w/your-team --client-id … --api-key … --number 024…
  Add --amount 5 to also ask that customer for a payment of GHS 5, and wait for their answer.
  Add --network telecel or --network at for the other networks (default mtn).

--sandbox is the "Base URL" shown at the top of your team's documentation page.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

# Settings can be given as arguments, which works on every system, or as environment variables.
parser = argparse.ArgumentParser(description="Signs in to a network and makes one call of each kind.")
parser.add_argument("--sandbox", default=os.environ.get("SANDBOX"), help="your team's Base URL, https://…/api/w/your-team")
parser.add_argument("--client-id", default=os.environ.get("CLIENT_ID"), help="from the network's API partners tab")
parser.add_argument("--api-key", default=os.environ.get("API_KEY"), help="from the network's API partners tab")
parser.add_argument("--number", default=os.environ.get("NUMBER"), help="a customer's number on that network")
parser.add_argument("--amount", default=os.environ.get("AMOUNT"), help="also ask the customer for this many cedis")
parser.add_argument("--network", default=os.environ.get("NETWORK", "mtn"), help="mtn, telecel or at (default mtn)")
options = parser.parse_args()
SANDBOX, CLIENT_ID, API_KEY, NUMBER, AMOUNT, NETWORK = options.sandbox, options.client_id, options.api_key, options.number, options.amount, options.network
if not (SANDBOX and CLIENT_ID and API_KEY and NUMBER):
    sys.exit("Usage: python3 app.py --sandbox https://…/api/w/your-team --client-id … --api-key … --number 024…   (see the top of this file)")
network = f"{SANDBOX.rstrip('/')}/network/{NETWORK}"
momo = f"{SANDBOX.rstrip('/')}/momo/{NETWORK}"


def call(method, url, headers=None, body=None):
    """One request. Returns the status and whatever came back."""
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as res:
            status, text = res.status, res.read().decode()
    except urllib.error.HTTPError as e:  # an answer such as 401 or 404 is still an answer
        status, text = e.code, e.read().decode()
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def show(what, status, data):
    print(f"\n{what}\n  {status}", data if isinstance(data, str) else json.dumps(data), flush=True)


# 1. Swap the client ID and API key for a token. It works on this network's APIs for an hour.
basic = base64.b64encode(f"{CLIENT_ID}:{API_KEY}".encode()).decode()
status, signed_in = call("POST", f"{network}/token", {"authorization": f"Basic {basic}"})
show("Signing in", status, {**signed_in, "access_token": "(received)"} if status == 200 else signed_in)
if status != 200:
    sys.exit(1)
auth = {"authorization": f"Bearer {signed_in['access_token']}"}

# 2. Network API: is the number in service, and was its SIM replaced lately? (A network never gives out the name.)
show("Is the number in service", *call("GET", f"{network}/v1/subscribers/{NUMBER}", auth))
show("Was the SIM replaced in the last 10 days?", *call("POST", f"{network}/v1/sim-swap/check", auth, {"phoneNumber": NUMBER, "maxAge": 240}))

# 3. Mobile money API: the name on the wallet.
show("The name on the wallet", *call("GET", f"{momo}/collection/v1_0/accountholder/msisdn/{NUMBER}/basicuserinfo", auth))

# 4. Mobile money API: ask the customer for a payment, then wait for their answer.
if AMOUNT:
    reference = str(uuid.uuid4())  # your own reference for this request
    status, asked = call(
        "POST",
        f"{momo}/collection/v1_0/requesttopay",
        {**auth, "x-reference-id": reference},
        {"amount": str(AMOUNT), "currency": "GHS", "externalId": "order-1", "payer": {"partyIdType": "MSISDN", "partyId": NUMBER}, "payerMessage": "Test payment", "payeeNote": "Starter kit"},
    )
    show(f"Asking {NUMBER} for GHS {AMOUNT}", status, asked)
    if status == 202:
        print("\nThe customer now approves or refuses on their phone. Open that number in the Phone simulator and dial the wallet code.", flush=True)
        for _ in range(60):
            status, answer = call("GET", f"{momo}/collection/v1_0/requesttopay/{reference}", auth)
            if not isinstance(answer, dict) or answer.get("status") != "PENDING":
                show("Their answer", status, answer)
                break
            print(".", end="", flush=True)
            time.sleep(2)
