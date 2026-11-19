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

-- Double-entry ledger: the postings of every transaction add up to zero.
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  account TEXT NOT NULL,             -- w:<wallet> | bank:<account> | fee:<party> | emoney:<telco> | vault:<bank> | switch:<party> | reserve:<bank>
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_txn ON postings(txn_id);
CREATE INDEX IF NOT EXISTS postings_account ON postings(account);

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
  kind TEXT NOT NULL,                -- cashout | rtp | dispute (external_id holds the ticket)
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
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
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
