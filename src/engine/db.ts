import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DB = DatabaseSync;

// Kept outside the project by default: the dev server's file watcher reloads pages whenever files in the project change.
export const DATA_DIR = process.env.SANDBOX_DATA_DIR || path.join(os.homedir(), ".momo-sandbox");
export const WORLDS_DIR = path.join(DATA_DIR, "worlds");
export const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
export const BASE_WORLD = path.join(DATA_DIR, "base.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ghana_card TEXT UNIQUE NOT NULL,
  region TEXT NOT NULL,
  town TEXT NOT NULL,
  gender TEXT NOT NULL,
  age INTEGER NOT NULL,
  role TEXT NOT NULL,              -- customer | agent | merchant | fraudster | mule
  susceptibility REAL NOT NULL,    -- 0..1, how likely to fall for a scam
  persona TEXT                     -- set for the featured personas participants play
);

CREATE TABLE IF NOT EXISTS sims (
  msisdn TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  telco TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  registered_at INTEGER NOT NULL,
  last_swap_at INTEGER
);
CREATE INDEX IF NOT EXISTS sims_person ON sims(person_id);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  msisdn TEXT UNIQUE NOT NULL,
  telco TEXT NOT NULL,
  person_id TEXT,
  owner_type TEXT NOT NULL,        -- person | agent | merchant
  display_name TEXT NOT NULL,
  kyc_tier TEXT NOT NULL,          -- minimum | medium | enhanced
  pin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | frozen | blacklisted
  balance INTEGER NOT NULL DEFAULT 0,    -- pesewas
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  wallet_id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  town TEXT NOT NULL,
  cash INTEGER NOT NULL,           -- physical cash on hand, pesewas
  colluding INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS merchants (
  wallet_id TEXT PRIMARY KEY,
  till TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  town TEXT NOT NULL,
  fake INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  account_no TEXT UNIQUE NOT NULL,
  person_id TEXT,
  name TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  msisdn TEXT NOT NULL,
  contact TEXT NOT NULL,
  PRIMARY KEY (msisdn, contact)
);

CREATE TABLE IF NOT EXISTS txns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- p2p | merchant | cashin | cashout | to_bank | from_bank | rtp
  channel TEXT NOT NULL,           -- ussd | app | api | system
  initiated_by TEXT NOT NULL,      -- human | bot | api
  from_wallet TEXT,
  to_wallet TEXT,
  bank_account TEXT,
  from_telco TEXT,
  to_telco TEXT,
  rail TEXT NOT NULL,              -- onnet | switch | bank
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- success | failed | blocked | held | reversed | abandoned | pending
  reason TEXT,
  reference TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  release_at INTEGER,
  warned INTEGER NOT NULL DEFAULT 0,
  second_factor INTEGER NOT NULL DEFAULT 0,
  checks TEXT,                     -- JSON array of fraud-check hits
  scenario TEXT,                   -- hidden ground truth
  is_fraud INTEGER NOT NULL DEFAULT 0  -- hidden ground truth
);
CREATE INDEX IF NOT EXISTS txns_created ON txns(created_at);
CREATE INDEX IF NOT EXISTS txns_from ON txns(from_wallet, created_at);
CREATE INDEX IF NOT EXISTS txns_to ON txns(to_wallet, created_at);
CREATE INDEX IF NOT EXISTS txns_status ON txns(status);

CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_txn ON postings(txn_id);

CREATE TABLE IF NOT EXISTS switch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  step TEXT NOT NULL,              -- lookup | quote | commit | reject
  from_telco TEXT,
  to_telco TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msisdn TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  scenario TEXT,
  is_fraud INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sms_msisdn ON sms(msisdn, at);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msisdn TEXT NOT NULL,
  caller TEXT NOT NULL,
  caller_label TEXT,
  script TEXT NOT NULL,
  at INTEGER NOT NULL,
  scenario TEXT,
  is_fraud INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS calls_msisdn ON calls(msisdn, at);

CREATE TABLE IF NOT EXISTS rtp (
  ref TEXT PRIMARY KEY,
  telco TEXT NOT NULL,
  payee_wallet TEXT NOT NULL,
  payer_msisdn TEXT NOT NULL,
  amount INTEGER NOT NULL,
  external_id TEXT,
  payer_message TEXT,
  payee_note TEXT,
  status TEXT NOT NULL,            -- PENDING | SUCCESSFUL | FAILED
  reason TEXT,
  txn_id TEXT,
  callback_url TEXT,
  created_at INTEGER NOT NULL,
  scenario TEXT,
  is_fraud INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rtp_payer ON rtp(payer_msisdn, status);

CREATE TABLE IF NOT EXISTS fraud_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  reporter_msisdn TEXT NOT NULL,
  category TEXT NOT NULL,
  at INTEGER NOT NULL
);

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
  author TEXT NOT NULL,            -- assistant | api | console | organiser
  at_real INTEGER NOT NULL,
  at_sim INTEGER NOT NULL,
  undone_by INTEGER
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  after TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | discarded
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_at ON agenda(at);

CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL
);
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
