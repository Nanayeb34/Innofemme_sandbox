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

Go to `/organiser`, sign in with the organiser access key, then **Print team QR cards**. A team's QR code opens its list of systems at `/t/{team}`. World files live in `~/.momo-sandbox` unless `SANDBOX_DATA_DIR` is set.

**Telco logos.** Put the official files from the partners in `public/brand/telcos/` as `mtn.svg`, `telecel.svg` and `at.svg` (PNG also works). Until then, brand-coloured wordmarks are shown.

```bash
pnpm test            # the whole journey, from an empty world to settlement
pnpm sandbox:smoke   # builds a small world in a throwaway directory and prints each step
pnpm typecheck && pnpm lint
```

## The systems

| Where | Who it is | What you do there |
| --- | --- | --- |
| `/t/{team}/nia` | National Identification Authority | Enrol people and issue Ghana Cards. Answer identity checks from telcos and banks; every check is logged. |
| `/t/{team}/telco/{mtn,telecel,at}` | A telco's back office | SIM stock, SIM registration points, wallets and KYC tiers, mobile money agents, merchants, transactions and reversals, fees, agent commission, the USSD menu, SMS notifications. |
| `/t/{team}/sim-agent/{telco}` | SIM registration point (service centre or registration agent) | Register a new SIM with Ghana Card and fingerprint, replace a SIM, block and unblock, reset a wallet PIN, enhanced KYC. No cash. |
| `/t/{team}/momo-agent/{telco}` | Mobile money agent | Cash-in, cash-out (the customer approves on their phone), register customers on medium KYC, move float, count the till. |
| `/t/{team}/phone` | Any registered SIM | Dial the wallet short code (`*170#` MTN, `*110#` Telecel and AT), `*400#`, `*402*1#`; SMS inbox; wallet. |
| `/t/{team}/bank/{gcb,ecobank,fidelity,calbank,absa,stanbic}` | A bank | Open accounts against the Ghana Card, cash deposits and withdrawals, transfers to banks and wallets, agent float, the telcos' trust accounts. |
| `/t/{team}/switch` | The national switch (GhIPSS in real life) | Connect and disconnect participants, watch the message log, see each participant's position, run net settlement. |
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
  ussd.ts              USSD session engine over each telco's editable menu tree
  bank.ts              bank accounts and the telcos' trust accounts
  switch.ts            routing (lookup, quote, commit), positions and net settlement
  ledger.ts            double-entry postings behind every movement of money
  config/              each institution's settings: schemas, defaults, history, undo, JSON Patch
  worlds.ts            team registry, one SQLite file per world, save points
src/server/systems.ts  one view and one set of actions per institution's console
src/app/               Next.js pages and API routes
```

These are the main design decisions:

- **Institutions are separate.** Each has its own console, its own settings document and its own audit trail. They reach each other only through real interfaces: a telco asks NIA to verify a card, a bank pushes money to a wallet through the switch.
- **Settings are data.** Menus, fees, limits, commissions, notifications and switch rules are validated against a schema, recorded, and can be undone.
- **One ledger, always balanced.** Every movement of money is a set of postings that adds up to zero. E-money exists only against real money: a telco's wallet balances always equal its trust account, adjusted for what is waiting to settle.
- **Settlement is deferred.** Payments between institutions clear at once but move money only when the switch settles. A telco settles through its trust account at its partner bank; banks settle across their accounts at the Bank of Ghana.
- **One SQLite file per world** (Node's built-in `node:sqlite`). Save points, rollback and reset are file operations, and the offline back-up needs no database server.
- **Biometrics are a code.** NIA gives each person a fingerprint code that stands in for their fingerprints. It must be presented wherever a biometric check is done.

## Where the simulation simplifies

- Each telco keeps its float in one trust account at one bank (MTN at GCB, Telecel at Ecobank, AT at Fidelity). Real issuers use many partner banks, and these pairings are not the real ones.
- Agent commission bands start from commonly reported MTN rates; the telcos publish no official rate card. The 24-hour pause on sending after a SIM replacement is a sandbox default, not a confirmed rule.
- The world runs on the real clock, so daily limits reset at midnight GMT.
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
- Menu trees: wording approximates the live menus. Replace it with the telcos' trees when they arrive.
- An AI assistant to help non-coders find their way around the systems.
- Fraud scenarios: removed for now; to be designed on top of this base.
