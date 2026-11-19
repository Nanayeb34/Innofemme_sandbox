# Mobile Money Sandbox

The sandbox for the Innofemme Mobile Money Fraud Hackathon (26–28 November, KNUST). It simulates the systems behind Ghana's mobile money, each as its own console, working together the way the real ones do. Every team gets its own copy.

**A new world is empty.** There are no people, SIM cards, wallets or money. The institutions exist with their starting settings, and everything else is created by going through the real processes: NIA issues a Ghana Card, a registration point registers a SIM against it, the customer opens a wallet, an agent buys float at a bank, and so on. Each step fails if the one before it was not done.

## Run it

```bash
pnpm install
cp .env.example .env.local
pnpm dev                     # http://localhost:3000
pnpm sandbox:info            # prints the organiser access key and every team's join link
```

Go to `/organiser`, sign in with the organiser access key, then **Print team QR cards**. World files live in `~/.momo-sandbox` unless `SANDBOX_DATA_DIR` is set.

Each team has three QR codes, and each opens something different:

| Code | Opens | For |
| --- | --- | --- |
| Team systems | Every console, at `/t/{team}` | The team's laptops. Keep it within the team. |
| Customer phone | Only the phone simulator | Anyone playing a customer, on their own phone. |
| Agent phone | Only the agent screens: mobile money agent and SIM registration, for any network | Anyone playing an agent, on their own phone. |

The two phone codes are also shown on the team's own systems page, so a team can put them on a screen for people to scan. A phone code cannot reach the consoles or the settings, in the browser or through the API.

**Telco logos.** Put the official files from the partners in `public/brand/telcos/` as `mtn.svg`, `telecel.svg` and `at.svg` (PNG also works). Until then, brand-coloured wordmarks are shown.

```bash
pnpm test            # the whole journey, from an empty world to settlement
pnpm sandbox:smoke   # builds a small world in a throwaway directory and prints each step
pnpm typecheck && pnpm lint
```

## Test it in GitHub Codespaces

A Codespace is a computer in your browser. Opening one on this repository installs, builds and starts the sandbox for you, with an HTTPS address that phones can open (needed for the QR codes and for voice calls).

1. On the repository's GitHub page, choose the branch, then **Code → Codespaces → Create codespace**.
2. Wait for the terminal to print the organiser key and each team's link (a few minutes the first time).
3. Open a team link on a laptop. Its page shows the customer and agent phone QR codes.

Things to know:

- **The address must be public.** The start script tries to make port 3000 public. If the terminal says it could not, open the **Ports** tab, right-click port 3000, and choose **Port Visibility → Public**.
- **First visit.** GitHub shows each new visitor a one-time notice that they are opening someone's Codespace. They continue past it.
- **It sleeps.** A Codespace stops after 30 minutes without activity in the Codespace itself; phones using the app do not count. Raise the limit under GitHub **Settings → Codespaces → Default idle timeout**, or keep the Codespace tab in use. Reopening it starts the sandbox again with the same worlds.
- **The address belongs to that Codespace.** A new Codespace has a new address and so new QR codes.

A Codespace holds the code as it was when the Codespace was created. To bring in changes pushed since then, run `bash .devcontainer/start.sh update` in its terminal: it fetches the latest code, rebuilds and restarts, and keeps the team worlds. `bash .devcontainer/start.sh stop` stops the sandbox and `bash .devcontainer/start.sh` starts it. This is for testing; for the event use the server under Deploying.

## The systems

| Where | Who it is | What you do there |
| --- | --- | --- |
| `/t/{team}/nia` | National Identification Authority | Enrol people and issue Ghana Cards. Answer identity checks from telcos and banks; every check is logged. |
| `/t/{team}/telco/{mtn,telecel,at}` | A telco's back office | SIM stock, SIM registration points, wallets and KYC tiers, mobile money agents, merchants, transactions and reversals, fees, agent commission, the USSD menu, SMS notifications. |
| `/t/{team}/care/{telco}` | A telco's customer care (call centre) | Answer calls to 100, check the caller against their record, open and work tickets, hold and return disputed money, send disputes to other networks, block a lost SIM. |
| `/t/{team}/sim-agent/{telco}` | SIM registration point (service centre or registration agent) | Register a new SIM with Ghana Card and fingerprint, replace a SIM, block and unblock, reset a wallet PIN, enhanced KYC. No cash. |
| `/t/{team}/momo-agent/{telco}` | Mobile money agent | Cash-in, cash-out (the customer approves on their phone), register customers on medium KYC, move float, count the till. |
| `/t/{team}/phone` | Any registered SIM | Dial the wallet short code (`*170#` MTN, `*110#` Telecel and AT), `*400#`, `*402*1#`; voice calls and text messages to other phones; wallet. |
| `/t/{team}/bank/{gcb,ecobank,fidelity,calbank,absa,stanbic}` | A bank | Open accounts against the Ghana Card, cash deposits and withdrawals, transfers to banks and wallets, agent float, the telcos' trust accounts. |
| `/t/{team}/switch` | The national switch (GhIPSS in real life) | Connect and disconnect participants, watch the message log, see each participant's position, run net settlement, follow disputes between networks. |
| `/t/{team}/bog` | Bank of Ghana | KYC tier limits for all networks; check that every telco's e-money is backed by its trust account. |
| `/t/{team}/nca` | National Communications Authority | SIM registration rules (SIMs per Ghana Card, minimum age, approval from the first number); the central SIM register across networks. |
| `/t/{team}/docs` | | API reference with the team's own base URL and key. |

There are **two kinds of agent**, as in real life. SIM registration points are authorised by a telco to register and fix SIMs; the telco is answerable for them. Mobile money agents handle cash and e-money on a dedicated agent line with its own float.

## How it is built

```
src/engine/            all simulation logic, no web code
  nia.ts               Ghana Card register and the identity verification service
  telco.ts             SIM stock, SIM registration and replacement, wallets, KYC, agents, merchants
  payments.ts          wallet payments, cash-in/out, bank transfers, teller cash, reversals
  approvals.ts         cash-out requests and Request to Pay, approved on the payer's phone
  care.ts              customer care tickets and the dispute process (hold, consent, return)
  calls.ts             voice calls: ringing, busy, switched off, the 100 queue, call records
  sms.ts               text messages between people and from businesses' apps; conversations and records
  partners.ts          API partners: the credentials each institution issues to outside companies
  signals.ts           what a network tells a partner about a number: subscriber details, SIM swap, KYC match
  ussdapps.ts          third-party USSD services on short codes the NCA allocates
  ussd.ts              USSD session engine over each telco's editable menu tree
  bank.ts              bank accounts and the telcos' trust accounts
  switch.ts            routing (lookup, quote, commit), positions and net settlement
  ledger.ts            double-entry postings behind every movement of money
  config/              each institution's settings: schemas, defaults, history, undo, JSON Patch
  worlds.ts            team registry, one SQLite file per world, save points
src/server/systems.ts  one view and one set of actions per institution's console
src/app/api/w/[team]/  momo, network, bank, ghipss, nia: the partner APIs; s: the console API
src/app/               Next.js pages and API routes
```

These are the main design decisions:

- **Institutions are separate.** Each has its own console, its own settings document and its own audit trail. They reach each other only through real interfaces: a telco asks NIA to verify a card, a bank pushes money to a wallet through the switch.
- **Settings are data.** Menus, fees, limits, commissions, notifications and switch rules are validated against a schema, recorded, and can be undone.
- **One ledger, always balanced.** Every movement of money is a set of postings that adds up to zero. E-money exists only against real money: a telco's wallet balances always equal its trust account, adjusted for what is waiting to settle.
- **Settlement is deferred.** Payments between institutions clear at once but move money only when the switch settles. A telco settles through its trust account at its partner bank; banks settle across their accounts at the Bank of Ghana.
- **One SQLite file per world** (Node's built-in `node:sqlite`). Save points, rollback and reset are file operations, and the offline back-up needs no database server.
- **Biometrics are a code.** NIA gives each person a fingerprint code that stands in for their fingerprints. It must be presented wherever a biometric check is done.

## Partner APIs

Besides the consoles, each institution has the API it would give an outside company, such as a licensed payments or messaging business. A company calls it with a client ID and API key that institution issued (its console → **API partners**), not with the team key. The API reference at `/t/{team}/docs` lists every endpoint.

| API | At | What it offers |
| --- | --- | --- |
| Mobile money | `/api/w/{team}/momo/{telco}` | The MTN MoMo Open API shape: request to pay, request to withdraw, pre-approval, delivery notification, balance, account-holder checks, profile with the customer's consent, transfer, deposit, refund, callbacks. |
| Network | `/api/w/{team}/network/{telco}` | Texts under a sender name, subscriber details, SIM-swap check, KYC match. |
| USSD services | NCA console, then each network | The NCA allocates a short code to a provider; each network switches it on and forwards sessions to the provider's application. |
| Bank | `/api/w/{team}/bank/{bank}` | Balance, statement, name enquiry, transfers to bank accounts and wallets, from the partner's own account. |
| National switch | `/api/w/{team}/ghipss` | Participants, name enquiry across banks and networks, status of a routed payment. |
| NIA | `/api/w/{team}/nia` | Ghana Card verification: valid or not with the card number, the holder's details on a fingerprint match. |

Subscriber details, texts, payments and identity checks are what licensed partners get in Ghana today. The SIM-swap and KYC-match checks are offered by MTN in other countries and could not be confirmed for Ghana. Not included: an outside company cannot see a network's full transaction feed, freeze a wallet or block a SIM; those stay inside the institution (the console API).

## Plug-in points

A team's product can be an API that a network, a bank or the national switch adds to its own system. Each
of their consoles has a **Plug-ins** tab: enter the API's address and choose the step it should be asked
at. From then on the institution sends the details to that API every time the step happens, waits for the
answer, and acts on it.

| Step | Who asks | Asked when | The API can answer |
| --- | --- | --- | --- |
| `pin.set` | network | a customer chooses or changes a wallet PIN | allow, reject |
| `wallet.open` | network | a wallet is about to be opened | allow, reject |
| `menu.open` | network | a customer opens the mobile money menu | allow, warn, reject |
| `payment.authorize` | network | a payment is about to leave a wallet | allow, warn, delay, reject |
| `payment.receive` | network, bank | money is about to arrive in a wallet or account | allow, reject |
| `payment.request` | network | a business or agent asks a customer to approve a payment | allow, reject |
| `kyc.upgrade` | network | a wallet's KYC level is about to be raised | allow, reject |
| `pin.reset` | network | a PIN is about to be reset at a service point | allow, reject |
| `business.onboard` | network | an agent or merchant is about to be signed up | allow, reject |
| `sim.register` | network | a SIM is about to be registered | allow, reject |
| `sim.swap` | network | a number is about to move to a replacement SIM | allow, reject |
| `sms.deliver` | network | a text is about to reach a subscriber | allow, warn, reject |
| `call.connect` | network | a call is about to ring a subscriber | allow, warn, reject |
| `transfer.authorize` | bank | a transfer is about to leave an account | allow, reject |
| `account.open` | bank | an account is about to be opened | allow, reject |
| `switch.route` | national switch | a payment is about to pass between two institutions | allow, reject |
| `events` | all | after something has happened | nothing: it is only told |

`examples/starter-api.mjs` is a starting point: it answers "allow" to everything and prints what it was
sent. The API reference inside the app (section 7) shows exactly what is sent at each step.

With nothing plugged in, the sandbox behaves exactly as it did before.

## Customer care and disputes

A customer raises a complaint by calling 100 (a real voice call to their network's care console, when an agent there is on line) or from the phone: wallet short code → My Wallet → Report a Problem. Either way a ticket is opened and the customer is told by SMS.

A dispute over a wallet-to-wallet payment is worked where the money now is, on the recipient's network:

1. **Hold.** Care moves whatever the recipient still has of the disputed amount out of their wallet, so it cannot be spent.
2. **Ask the recipient.** The recipient gets an SMS and answers on their own phone (option 4): agree with their PIN, or refuse.
3. **Return or reject.** Held money goes back to the sender, with the fee when everything is recovered; or the claim is rejected and the hold is released.

When the recipient is on another network, the sender's network cannot touch the money. It sends the dispute through the national switch; the recipient's network gets a ticket of its own and decides, and the sender's ticket follows along. Returned money travels back through the switch. A disputed cash-out is reversed in full, including the agent's till and commission.

Care cannot reset a PIN or replace a SIM: those need the customer in person at a service centre. Worlds created before this feature keep their old USSD menu; add a `report_problem` action node to the menu in the telco's settings, or reset the world.

## Text messages

Every phone has a Messages app with conversations. There are three kinds of text, and each network keeps a record of all of them in its back office (SMS tab):

- **Person to person.** Write to any number on any network and reply in the thread. A blocked SIM cannot send, and a text to a number that is not in service, or is blocked, is recorded as not delivered. A phone that is not open still receives its texts: they wait in the inbox.
- **From the network.** The texts a telco sends about its own services (registration, payments, approvals, tickets). Their wording is editable in the telco's settings. Nobody can reply to them.
- **From a business's app.** `POST /api/w/{team}/network/{telco}/v1/sms/messages` with `{ to, text }` and the partner's credentials. The text arrives under the company's registered name, shortened to 11 letters and digits, with no reply.

A text is at most 480 characters and is counted in 160-character parts. Texts are free: there is no airtime yet.

## Voice calls

Dial another registered number from the phone and that phone rings; the two people then talk with real audio. The server plays the network (ringing, busy, switched off, the telco's call records) and the audio goes directly between the two browsers over WebRTC.

- **The other phone must be open.** A number rings only while someone has its phone screen open. Otherwise the caller hears that it is switched off, and the owner gets a missed-call SMS.
- **HTTPS is required.** Browsers allow the microphone only on a secure address (or `localhost`).
- **Relay.** On Wi-Fi that stops devices reaching each other, audio needs a relay. Set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` (Cloudflare dashboard → Realtime → TURN → create a key) and the sandbox issues short-lived Cloudflare relay credentials to each phone. Without them, calls try to connect directly.

## Where the simulation simplifies

- Each telco keeps its float in one trust account at one bank (MTN at GCB, Telecel at Ecobank, AT at Fidelity). Real issuers use many partner banks, and these pairings are not the real ones.
- Agent commission bands start from commonly reported MTN rates; the telcos publish no official rate card. The 24-hour pause on sending after a SIM replacement is a sandbox default, not a confirmed rule.
- The world runs on the real clock, so daily limits reset at midnight GMT.
- Calls are free: there is no airtime yet. 100 is the only short number that connects.
- Not modelled: airtime and bundles, number porting, master agents and sub-agents, merchant KYC tiers, interest on float, guardians for under-18s, self-service SIM replacement.

## Deploying (GCP)

All worlds run in a single process: USSD sessions live in memory and the worlds are SQLite files. Run it on **one Compute Engine VM** (e2-standard-2 is plenty for 10 teams) with a persistent disk, not on autoscaled Cloud Run. `deploy/gcp.sh` sets this up.

```bash
docker build -t momo-sandbox .
docker run -d -p 80:3000 -v /mnt/disks/sandbox:/data --env-file .env momo-sandbox
```

The same image runs the venue's offline back-up server. Copy `/data` from the cloud VM to move the teams' worlds across.

## Still open

- Telecel and AT API specs: both telcos currently use the MTN API shape.
- GhIPSS products not yet modelled: the national QR code, Proxy Pay and its own Request to Pay.
- Menu trees: wording approximates the live menus. Replace it with the telcos' trees when they arrive.
- An AI assistant to help non-coders find their way around the systems.
- Fraud scenarios: removed for now; to be designed on top of this base.
