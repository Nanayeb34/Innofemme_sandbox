# MoMo Fraud Sandbox

The sandbox for the Innofemme Mobile Money Fraud Hackathon (26–28 November, KNUST). It is a fully synthetic replica of Ghana's mobile money system: customers, agents and merchants on MTN MoMo, Telecel Cash and AT Money, banks, and a national switch, with scam bots running the ten draft fraud scenarios. Each team gets its own copy, opens it on their phone through a QR code, and changes it through an AI assistant (non-coders) or an HTTP API (coders).

## Run it

```bash
pnpm install
cp .env.example .env.local   # add OPENAI_API_KEY to enable the assistant
pnpm dev                     # http://localhost:3000
pnpm sandbox:info            # prints the organiser access key and every team's join link
```

The first request builds the base world (about 1,400 people, 60 agents, 80 merchants, fraudsters and mules) in `~/.momo-sandbox`, and each team world is a copy of it. Go to `/organiser`, sign in with the organiser access key, then **Print team QR cards**.

**Telco logos.** Put the official files from the partners in `public/brand/telcos/` as `mtn.svg`, `telecel.svg` and `at.svg` (PNG also works). They appear on the home page and the phone automatically; until then, brand-coloured wordmarks are shown.

```bash
pnpm test            # engine and assistant tests
pnpm sandbox:smoke   # simulates a day in a throwaway world and walks a *170# transfer
pnpm typecheck && pnpm lint
```

## What participants get

| Where | What |
| --- | --- |
| `/t/{team}/phone` | Sandbox phone. Dial `*170#` (MTN) or `*110#` (Telecel, AT); SMS inbox with scam messages; MoMo wallet; scam calls. Five personas, PIN `1234`. |
| `/t/{team}/console` | Simulated clock with pause, speed and fast-forward (6h, 1d, 3d), KPIs, AI assistant with review, apply and undo, live feed, change impact, controls, snapshots and reset. |
| `/t/{team}/docs` | API reference with the team's own base URL and key. |
| `/api/w/{team}/momo/{mtn,telecel,at}/…` | Telco API in the MTN MoMo Open API shape: token, Request to Pay, transfers, balance, account holder. |

## How it is built

```
src/engine/            all simulation logic, no web code
  config/schemas.ts    the five control surfaces (zod) and the condition language
  config/defaults.ts   starting menus, BoG KYC limits, telco fee schedules, notifications, checks, scenarios
  config/store.ts      validated config with history, undo and JSON Patch
  population.ts        deterministic synthetic population (Ghana Card IDs, SIMs, wallets, contacts)
  payments.ts          the payment pipeline: limits → fees → fraud checks → switch → ledger
  ussd.ts              USSD session engine over the editable menu trees
  rtp.ts               Request to Pay
  fraud.ts             the ten scam scenarios, with hidden ground-truth labels
  sim.ts               clock, genuine traffic, scheduled scam steps, fast-forward
  scoring.ts           metrics and before/after impact of each change
  assistant.ts         AI assistant (AI SDK + OpenAI) restricted to proposing validated patches
  worlds.ts            team registry, one SQLite file per world, snapshots, real-time ticker
src/app/               Next.js pages and API routes
```

These are the main design decisions:

- **Rules are data.** Teams, the assistant and the API change only the five control surfaces: menus, rules, notifications, fraud checks and scenarios. Each change is validated against a schema, recorded, and can be undone. The assistant cannot touch code or other teams' worlds.
- **One SQLite file per world** (Node's built-in `node:sqlite`). Snapshot, reset and rollback are file copies, and the offline back-up needs no database server.
- **Ground truth stays hidden.** Each scam payment carries `scenario` and `is_fraud` labels: 1 for a payment the victim made, 2 for a mule laundering hop. Teams see aggregate counts and the scams customers report after the fact. Organisers see everything.
- **Behaviour responds to controls.** Warnings talk some victims out of paying. Holds give victims time to report and get their money back. A second factor stops impostors, but an SMS code does not stop a SIM swap. Every control also adds friction for genuine users, and the score counts that cost.
- **National switch** built in-house, following Mojaloop's three steps: look up the recipient's network, quote, commit. Every step is logged in `switch_log`.

## Deploying (GCP)

All worlds run in a single process: the real-time ticker and USSD sessions live in memory, and the worlds are SQLite files. Run it on **one Compute Engine VM** (e2-standard-2 is plenty for 10 teams) with a persistent disk, not on autoscaled Cloud Run.

```bash
docker build -t momo-sandbox .
docker run -d -p 80:3000 -v /mnt/disks/sandbox:/data --env-file .env momo-sandbox
```

The same image runs the venue's offline back-up server. OpenAI is not reachable offline, so set `OPENAI_BASE_URL` to a local OpenAI-compatible server such as Ollama and `OPENAI_MODEL` to a local model. Copy `/data` from the cloud VM to move the teams' worlds across.

## Fees

`config/defaults.ts` holds the confirmed tariffs as amount bands. MTN: P2P 0.75% up to GH₵1,000 then GH₵7.50 flat; cash-out GH₵0.50 below GH₵50, 1% to GH₵1,999.99, GH₵20 from GH₵2,000; wallet-to-bank 0.75% capped at GH₵5. Telecel: on-net free; off-net free to GH₵100, 0.5% to GH₵1,000, then GH₵5; cash-out GH₵0.50 to GH₵50, 1% to GH₵2,000, then GH₵20. AT uses the MTN schedule. Merchant payments and receiving are free. Telecel wallet-to-bank isn't in its published table and follows MTN until confirmed.

## Still open (from the design doc)

- Telecel and AT API specs: both telcos currently use the MTN API shape.
- Menu trees: wording approximates the live menus. Replace it with the telcos' trees when they arrive.
- Whether teams can attack each other: worlds are fully isolated for now.
- Final judging weights: the score in `scoring.ts` is provisional.
