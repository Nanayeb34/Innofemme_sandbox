import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DB = DatabaseSync;

// Kept outside the project by default: the dev server's file watcher reloads pages whenever files in the project change.
export const DATA_DIR = process.env.SANDBOX_DATA_DIR || path.join(os.homedir(), ".momo-sandbox");
export const WORLDS_DIR = path.join(DATA_DIR, "worlds");
export const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");

/** Bump when the schema changes shape; older world files are replaced by a fresh, empty world. */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ===== NIA: the national identity register =====
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  ghana_card TEXT UNIQUE NOT NULL,   -- GHA-000000000-0
  surname TEXT NOT NULL,
  first_names TEXT NOT NULL,
  dob TEXT NOT NULL,                 -- YYYY-MM-DD
  gender TEXT NOT NULL,              -- F | M
  nationality TEXT NOT NULL,
  region TEXT NOT NULL,
  town TEXT NOT NULL,
  fingerprint TEXT NOT NULL,         -- stands in for the holder's biometrics
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  issued_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nia_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  requester TEXT NOT NULL,           -- institution asking: mtn, gcb, ...
  purpose TEXT NOT NULL,
  ghana_card TEXT NOT NULL,
  biometric INTEGER NOT NULL,        -- 1 when a fingerprint was checked
  result TEXT NOT NULL               -- MATCH | NOT_FOUND | BIOMETRIC_MISMATCH | CARD_SUSPENDED
);

-- ===== Telcos: SIMs and the people who register them =====
CREATE TABLE IF NOT EXISTS sims (
  msisdn TEXT PRIMARY KEY,
  telco TEXT NOT NULL,
  iccid TEXT NOT NULL,               -- serial of the physical SIM card currently holding the number
  puk TEXT NOT NULL,
  status TEXT NOT NULL,              -- in_stock | active | blocked | deactivated
  person_id TEXT,
  registered_at INTEGER,
  registered_by TEXT,                -- SIM registration agent id
  last_swap_at INTEGER,
  block_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sims_person ON sims(person_id);
CREATE INDEX IF NOT EXISTS sims_telco ON sims(telco, status);
-- The newest numbers, for the lists on the phone, the network's and the NCA's screens; and how many each point registered.
CREATE INDEX IF NOT EXISTS sims_registered ON sims(registered_at);
CREATE INDEX IF NOT EXISTS sims_telco_registered ON sims(telco, registered_at);
CREATE INDEX IF NOT EXISTS sims_registered_by ON sims(registered_by);

CREATE TABLE IF NOT EXISTS sim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msisdn TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- registered | swapped | blocked | unblocked | deactivated | pin_reset
  by TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS sim_events_msisdn ON sim_events(msisdn);

-- SIM registration and troubleshooting points (service centres and registration agents)
CREATE TABLE IF NOT EXISTS sim_agents (
  id TEXT PRIMARY KEY,               -- e.g. MTN-SR-0001
  telco TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- service_centre | registration_agent
  town TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at INTEGER NOT NULL
);

-- ===== Telcos: mobile money =====
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,               -- w_<msisdn>
  msisdn TEXT UNIQUE NOT NULL,
  telco TEXT NOT NULL,
  person_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,          -- person | agent | merchant
  display_name TEXT NOT NULL,
  kyc_tier TEXT NOT NULL,            -- minimum | medium | enhanced
  pin TEXT NOT NULL,
  pin_fails INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | frozen | locked
  balance INTEGER NOT NULL DEFAULT 0,    -- pesewas
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wallets_telco_created ON wallets(telco, created_at);

CREATE TABLE IF NOT EXISTS momo_agents (
  wallet_id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,         -- agent/till number
  name TEXT NOT NULL,
  town TEXT NOT NULL,
  cash INTEGER NOT NULL DEFAULT 0,   -- physical cash in the till, pesewas
  commission INTEGER NOT NULL DEFAULT 0, -- total earned, pesewas
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  wallet_id TEXT PRIMARY KEY,
  till TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  town TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ===== Banks =====
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  account_no TEXT UNIQUE NOT NULL,
  person_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- personal | trust
  telco TEXT,                        -- for trust accounts: whose float it backs
  status TEXT NOT NULL DEFAULT 'active', -- active | frozen
  balance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_accounts_bank ON bank_accounts(bank);

-- ===== Money movement (all institutions) =====
CREATE TABLE IF NOT EXISTS txns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                -- p2p | merchant | cashin | cashout | wallet_to_bank | bank_to_wallet | bank_transfer | deposit | withdrawal | reversal | settlement
  channel TEXT NOT NULL,             -- ussd | agent | branch | api | console | system
  from_wallet TEXT,
  to_wallet TEXT,
  from_account TEXT,
  to_account TEXT,
  from_party TEXT,                   -- institution of the payer (mtn, gcb, ...)
  to_party TEXT,
  rail TEXT NOT NULL,                -- onnet | switch | internal | cash
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,              -- success | failed | reversed
  reason TEXT,
  reference TEXT,
  related TEXT,                      -- for reversals: the original transaction
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS txns_created ON txns(created_at);
CREATE INDEX IF NOT EXISTS txns_from ON txns(from_wallet, created_at);
CREATE INDEX IF NOT EXISTS txns_to ON txns(to_wallet, created_at);

-- How many payments of each kind there are and what they add up to. The database keeps these itself as payments
-- are written, changed or removed, so the totals on the screens never mean counting the whole history again.
CREATE TABLE IF NOT EXISTS txn_totals (
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  rail TEXT NOT NULL,
  from_party TEXT NOT NULL,          -- '' where the payment has none
  to_party TEXT NOT NULL,
  n INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (status, type, rail, from_party, to_party)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS txns_added AFTER INSERT ON txns BEGIN
  INSERT INTO txn_totals(status, type, rail, from_party, to_party, n, amount)
    VALUES(NEW.status, NEW.type, NEW.rail, COALESCE(NEW.from_party, ''), COALESCE(NEW.to_party, ''), 1, NEW.amount)
    ON CONFLICT(status, type, rail, from_party, to_party) DO UPDATE SET n = n + 1, amount = amount + excluded.amount;
END;
CREATE TRIGGER IF NOT EXISTS txns_removed AFTER DELETE ON txns BEGIN
  UPDATE txn_totals SET n = n - 1, amount = amount - OLD.amount
    WHERE status = OLD.status AND type = OLD.type AND rail = OLD.rail AND from_party = COALESCE(OLD.from_party, '') AND to_party = COALESCE(OLD.to_party, '');
END;
CREATE TRIGGER IF NOT EXISTS txns_changed AFTER UPDATE ON txns BEGIN
  UPDATE txn_totals SET n = n - 1, amount = amount - OLD.amount
    WHERE status = OLD.status AND type = OLD.type AND rail = OLD.rail AND from_party = COALESCE(OLD.from_party, '') AND to_party = COALESCE(OLD.to_party, '');
  INSERT INTO txn_totals(status, type, rail, from_party, to_party, n, amount)
    VALUES(NEW.status, NEW.type, NEW.rail, COALESCE(NEW.from_party, ''), COALESCE(NEW.to_party, ''), 1, NEW.amount)
    ON CONFLICT(status, type, rail, from_party, to_party) DO UPDATE SET n = n + 1, amount = amount + excluded.amount;
END;

-- Double-entry ledger: the postings of every transaction add up to zero.
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  account TEXT NOT NULL,             -- w:<wallet> | bank:<account> | fee:<party> | emoney:<telco> | vault:<bank> | switch:<party> | reserve:<bank> | airtime:<telco> | billers:<telco>
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_txn ON postings(txn_id);
-- An account's balance is read from this alone: its postings in the order they were written, with their amounts.
CREATE INDEX IF NOT EXISTS postings_balance ON postings(account, id, amount);
DROP INDEX IF EXISTS postings_account;

-- ===== National switch =====
CREATE TABLE IF NOT EXISTS switch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT,
  step TEXT NOT NULL,                -- lookup | quote | commit | reject | settlement
  from_party TEXT,
  to_party TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS switch_log_step ON switch_log(step);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL               -- JSON: net position settled per participant
);

-- ===== Phones =====
CREATE TABLE IF NOT EXISTS sms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msisdn TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_msisdn ON sms(msisdn, id);

-- The telcos' record of every text message: between people, from the network, and from businesses' apps.
-- The sms table above is each phone's inbox; this is what was sent, delivered or not.
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- person | network | app
  sender TEXT NOT NULL,              -- a phone number, or a sender name such as MTNMoMo
  from_telco TEXT,
  to_msisdn TEXT NOT NULL,
  to_telco TEXT,
  body TEXT NOT NULL,
  parts INTEGER NOT NULL DEFAULT 1,  -- how many 160-character messages it was sent as
  status TEXT NOT NULL,              -- delivered | failed
  reason TEXT
);
CREATE INDEX IF NOT EXISTS sms_log_sender ON sms_log(sender, id);
CREATE INDEX IF NOT EXISTS sms_log_to ON sms_log(to_msisdn, id);

-- Voice calls between phones (the telcos' call records). The audio itself goes phone to phone.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  from_msisdn TEXT NOT NULL,
  to_msisdn TEXT NOT NULL,
  from_telco TEXT NOT NULL,
  to_telco TEXT,
  status TEXT NOT NULL,              -- ringing | active | ended | missed | declined | busy | failed
  reason TEXT,
  started_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS calls_from ON calls(from_msisdn, started_at);
CREATE INDEX IF NOT EXISTS calls_to ON calls(to_msisdn, started_at);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at);
-- Every open phone asks once a second whether a call is ringing or in progress.
CREATE INDEX IF NOT EXISTS calls_status ON calls(status);

-- ===== Customer care =====
-- Complaints and disputes handled by a telco's call centre.
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,               -- e.g. MTN-000012
  telco TEXT NOT NULL,
  msisdn TEXT NOT NULL,              -- the customer on this network the ticket is about
  category TEXT NOT NULL,            -- wrong_transfer | unauthorised | agent_complaint | sim_network | wallet_access | other
  description TEXT NOT NULL,
  channel TEXT NOT NULL,             -- call | ussd | back_office | network (raised by another network through the switch)
  status TEXT NOT NULL,              -- open | awaiting_recipient | with_other_network | resolved | rejected
  txn_id TEXT,                       -- the disputed payment, if any
  role TEXT,                         -- this network's side of the disputed payment: sender | recipient | both
  linked_ticket TEXT,                -- the other network's ticket for the same dispute
  held INTEGER NOT NULL DEFAULT 0,   -- recipient's funds currently on hold, pesewas
  returned INTEGER NOT NULL DEFAULT 0, -- already given back to the sender, pesewas
  resolution TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_telco ON tickets(telco, status);
-- A call centre's list: open complaints first, then the most recently touched.
CREATE INDEX IF NOT EXISTS tickets_open_first ON tickets(telco, (status IN ('resolved','rejected')), updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_txn ON tickets(txn_id);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events(ticket_id);

-- Payment requests waiting for the payer's approval: agent cash-outs and merchant Request to Pay.
CREATE TABLE IF NOT EXISTS approvals (
  ref TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- cashout | rtp | dispute | preapproval | consent (external_id holds the ticket or reference)
  telco TEXT NOT NULL,
  payee_wallet TEXT NOT NULL,
  payer_msisdn TEXT NOT NULL,
  amount INTEGER NOT NULL,
  external_id TEXT,
  payer_message TEXT,
  payee_note TEXT,
  status TEXT NOT NULL,              -- PENDING | SUCCESSFUL | FAILED
  reason TEXT,
  txn_id TEXT,
  callback_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_payer ON approvals(payer_msisdn, status);

CREATE TABLE IF NOT EXISTS api_transfers (
  ref TEXT PRIMARY KEY,
  telco TEXT NOT NULL,
  payee_msisdn TEXT NOT NULL,
  amount INTEGER NOT NULL,
  external_id TEXT,
  payer_message TEXT,
  payee_note TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  txn_id TEXT,
  created_at INTEGER NOT NULL
);

-- ===== Partner APIs =====
-- A company an institution has given API access to (what a telco, bank, GhIPSS or NIA issues to a licensed partner).
CREATE TABLE IF NOT EXISTS api_clients (
  id TEXT PRIMARY KEY,               -- the client id (MTN calls it the API user)
  institution TEXT NOT NULL,         -- mtn | telecel | at | a bank | switch | nia
  name TEXT NOT NULL,
  secret TEXT NOT NULL,              -- the API key
  wallet_id TEXT,                    -- telco partners: the merchant wallet they collect into and pay out from
  account_id TEXT,                   -- bank partners: the account they operate
  callback_url TEXT,                 -- where results are sent when a request does not name its own
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  calls INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS api_clients_institution ON api_clients(institution);

-- A customer's standing permission for a partner to take payments without asking each time.
CREATE TABLE IF NOT EXISTS preapprovals (
  ref TEXT PRIMARY KEY,
  telco TEXT NOT NULL,
  payee_wallet TEXT NOT NULL,
  payer_msisdn TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL,              -- PENDING | SUCCESSFUL | FAILED
  reason TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS preapprovals_pair ON preapprovals(payee_wallet, payer_msisdn);

-- A customer's consent for a partner to read their profile.
CREATE TABLE IF NOT EXISTS consents (
  ref TEXT PRIMARY KEY,              -- auth_req_id
  telco TEXT NOT NULL,
  client_id TEXT NOT NULL,
  msisdn TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,              -- PENDING | APPROVED | REJECTED
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- USSD short codes the NCA has allocated to service providers, and the networks each is switched on for.
CREATE TABLE IF NOT EXISTS ussd_codes (
  code TEXT PRIMARY KEY,             -- e.g. *714#
  owner TEXT NOT NULL,
  url TEXT NOT NULL,                 -- the provider's application; the network forwards each step of a session to it
  status TEXT NOT NULL DEFAULT 'allocated', -- allocated | revoked
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ussd_activations (
  code TEXT NOT NULL,
  telco TEXT NOT NULL,
  PRIMARY KEY (code, telco)
);

-- ===== Wallet services =====
-- Airtime and data on each line. A line with no row has none.
CREATE TABLE IF NOT EXISTS sim_balances (
  msisdn TEXT PRIMARY KEY,
  airtime INTEGER NOT NULL DEFAULT 0,  -- pesewas
  data_mb INTEGER NOT NULL DEFAULT 0,
  data_expires INTEGER
);

-- A voucher for a cardless withdrawal at a bank's cash machine. The money leaves the wallet when it is used.
CREATE TABLE IF NOT EXISTS atm_vouchers (
  code TEXT PRIMARY KEY,
  msisdn TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  telco TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,              -- active | used | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  bank TEXT,                         -- where it was used
  txn_id TEXT
);
CREATE INDEX IF NOT EXISTS atm_vouchers_msisdn ON atm_vouchers(msisdn, status);

-- Bills paid from wallets, as each biller would see them.
CREATE TABLE IF NOT EXISTS bill_payments (
  txn_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  telco TEXT NOT NULL,
  biller TEXT NOT NULL,
  account_ref TEXT NOT NULL,         -- meter, smartcard or account number
  amount INTEGER NOT NULL,
  token TEXT,                        -- e.g. a prepaid electricity token
  msisdn TEXT NOT NULL
);

-- Wallets whose PIN was issued by the network (a reset, or a wallet opened by an agent) and must be replaced on first use.
CREATE TABLE IF NOT EXISTS pin_temporary (
  wallet_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

-- ===== Simulated data =====
-- One row for each transaction of a loaded simulated history, with what it really was.
CREATE TABLE IF NOT EXISTS dataset (
  txn_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,              -- its place in time order, from 1
  is_fraud INTEGER NOT NULL,
  scenario TEXT,                     -- which kind of fraud
  role TEXT,                         -- the part this transaction plays in the case
  case_id TEXT,                      -- transactions of one case share this
  payment_request INTEGER NOT NULL DEFAULT 0 -- 1 when the payer approved a request sent by the payee
);
CREATE INDEX IF NOT EXISTS dataset_seq ON dataset(seq);

-- ===== Fraud simulator =====
-- A standalone application connected to the fraud simulator: it is sent fraud incidents directly.
CREATE TABLE IF NOT EXISTS fraud_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  kinds TEXT NOT NULL,               -- JSON list of the kinds of fraud it is built to stop
  created_at INTEGER NOT NULL
);

-- One run of the fraud simulator.
CREATE TABLE IF NOT EXISTS fraud_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,              -- running | finished | stopped
  kinds TEXT NOT NULL,               -- JSON list of the kinds of fraud asked for
  target TEXT NOT NULL,              -- "plugins", or the name of the application tested
  planned INTEGER NOT NULL,          -- fraud incidents asked for
  ordinary INTEGER NOT NULL,         -- pieces of ordinary activity asked for
  seed INTEGER NOT NULL,
  note TEXT
);

-- What happened to each incident (and each piece of ordinary activity) in a run.
CREATE TABLE IF NOT EXISTS fraud_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- fraud | ordinary
  scenario TEXT NOT NULL,
  who TEXT,                          -- the victim, or the customer
  outcome TEXT NOT NULL,             -- fraud: stopped | contained | through | void. ordinary: fine | slowed | blocked | void
  stopped_at TEXT,                   -- the step (plug-in point) where it was stopped
  stopped_by TEXT,                   -- the API or application that stopped it
  answer TEXT,                       -- what it answered
  at_risk INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  trail TEXT NOT NULL                -- JSON: the steps, in order
);
CREATE INDEX IF NOT EXISTS fraud_incidents_run ON fraud_incidents(run_id, id);

-- ===== Plug-in points =====
-- An outside company's API that an institution has plugged into one of its own steps. The institution
-- calls it at that step and acts on the answer.
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,         -- mtn | telecel | at | a bank
  point TEXT NOT NULL,               -- the step it is plugged into, e.g. pin.set, payment.authorize
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  fail_open INTEGER NOT NULL DEFAULT 1, -- when the API does not answer: 1 carry on, 0 refuse
  timeout_ms INTEGER NOT NULL DEFAULT 2000,
  calls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integrations_point ON integrations(institution, point);

-- What each plugged-in API was asked and what it answered.
CREATE TABLE IF NOT EXISTS integration_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  integration_id TEXT NOT NULL,
  institution TEXT NOT NULL,
  point TEXT NOT NULL,
  request TEXT NOT NULL,
  decision TEXT NOT NULL,            -- allow | warn | delay | reject | error | sent (for events)
  message TEXT,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_calls_inst ON integration_calls(institution, id);

-- ===== Settings and audit =====
CREATE TABLE IF NOT EXISTS config (
  surface TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  summary TEXT NOT NULL,
  author TEXT NOT NULL,              -- console | api | organiser
  at INTEGER NOT NULL,
  undone_by INTEGER
);

-- What each institution did, in order. The story of the world.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  system TEXT NOT NULL,              -- nia | mtn | telecel | at | gcb | ... | switch | bog | nca
  action TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_system ON audit(system, id);
`;

export function openDb(file: string): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;");
  db.exec(SCHEMA);
  // A world made before the running totals existed has them worked out once, here.
  if (getMeta(db, "txn_totals") !== "1") {
    db.exec(`BEGIN; DELETE FROM txn_totals;
      INSERT INTO txn_totals SELECT status, type, rail, COALESCE(from_party, ''), COALESCE(to_party, ''), COUNT(*), SUM(amount) FROM txns GROUP BY 1, 2, 3, 4, 5;
      INSERT INTO meta(key, value) VALUES('txn_totals', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value; COMMIT;`);
  }
  return db;
}

let savepoints = 0;

/** Runs `fn` so that its writes all happen or none do. Inside a larger transaction it uses a savepoint, so it stays all-or-nothing on its own. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string | number) {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export const count = (db: DB, sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
