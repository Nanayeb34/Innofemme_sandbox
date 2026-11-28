import type { World } from "./world";

/**
 * The simulated history as files a team can download and study: one row per transaction, with what
 * each one really was, and the people, lines, wallets, calls and texts around them.
 */

interface FileSpec {
  about: string;
  /** Rows are read a page at a time, in the order of `key`, so a download never holds up the world for long. */
  sql: string;
  key: string;
  columns: string[];
  /** Columns that say which transactions are fraud. Left out when the file is asked for without answers. */
  answers?: string[];
}

const time = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col} / 1000, 'unixepoch')`;

export const DATASET_FILES: Record<string, FileSpec> = {
  transactions: {
    about: "Every transaction, in time order, with whether it was fraud and of which kind",
    key: "d.seq",
    sql: `SELECT d.seq AS _key, d.seq AS number, t.id AS transaction_id, ${time("t.created_at")} AS time, t.type, t.channel, t.status, t.reason AS failure_reason,
        t.amount / 100.0 AS amount, t.fee / 100.0 AS fee,
        fw.msisdn AS payer_number, fw.owner_type AS payer_wallet_type, t.from_party AS payer_institution, fa.account_no AS payer_account,
        tw.msisdn AS payee_number, tw.owner_type AS payee_wallet_type, t.to_party AS payee_institution, ta.account_no AS payee_account,
        CASE WHEN t.rail = 'switch' THEN 1 ELSE 0 END AS through_national_switch, t.reference, d.payment_request AS approved_payment_request,
        d.is_fraud, d.scenario AS fraud_scenario, d.role AS fraud_role, d.case_id AS fraud_case
      FROM dataset d JOIN txns t ON t.id = d.txn_id
      LEFT JOIN wallets fw ON fw.id = t.from_wallet LEFT JOIN wallets tw ON tw.id = t.to_wallet
      LEFT JOIN bank_accounts fa ON fa.id = t.from_account LEFT JOIN bank_accounts ta ON ta.id = t.to_account`,
    columns: ["number", "transaction_id", "time", "type", "channel", "status", "failure_reason", "amount", "fee", "payer_number", "payer_wallet_type", "payer_institution", "payer_account", "payee_number", "payee_wallet_type", "payee_institution", "payee_account", "through_national_switch", "reference", "approved_payment_request", "is_fraud", "fraud_scenario", "fraud_role", "fraud_case"],
    answers: ["is_fraud", "fraud_scenario", "fraud_role", "fraud_case"],
  },
  people: {
    about: "Everyone on the national identity register",
    key: "p.rowid",
    sql: `SELECT p.rowid AS _key, p.ghana_card, p.first_names, p.surname, p.dob AS date_of_birth, p.gender, p.region, p.town, ${time("p.issued_at")} AS card_issued FROM persons p`,
    columns: ["ghana_card", "first_names", "surname", "date_of_birth", "gender", "region", "town", "card_issued"],
  },
  sims: {
    about: "Every registered number: its network, whose Ghana Card it is on, where it was registered, and its last replacement",
    key: "s.rowid",
    sql: `SELECT s.rowid AS _key, s.msisdn AS number, s.telco AS network, p.ghana_card, s.status, ${time("s.registered_at")} AS registered, s.registered_by AS registration_point, ${time("s.last_swap_at")} AS last_sim_replacement
      FROM sims s JOIN persons p ON p.id = s.person_id`,
    columns: ["number", "network", "ghana_card", "status", "registered", "registration_point", "last_sim_replacement"],
  },
  sim_events: {
    about: "What happened to each number: registration, SIM replacement, PIN reset, blocks",
    key: "e.id",
    sql: `SELECT e.id AS _key, e.msisdn AS number, ${time("e.at")} AS time, e.kind AS event, e.by AS registration_point, e.detail FROM sim_events e`,
    columns: ["number", "time", "event", "registration_point", "detail"],
  },
  wallets: {
    about: "Every mobile money wallet as it stands at the end of the period",
    key: "w.rowid",
    sql: `SELECT w.rowid AS _key, w.msisdn AS number, w.telco AS network, p.ghana_card, w.owner_type AS wallet_type, w.display_name AS name, w.kyc_tier, w.status, ${time("w.created_at")} AS opened, w.balance / 100.0 AS balance,
        a.code AS agent_number, m.till AS merchant_id, m.category AS merchant_category
      FROM wallets w JOIN persons p ON p.id = w.person_id LEFT JOIN momo_agents a ON a.wallet_id = w.id LEFT JOIN merchants m ON m.wallet_id = w.id`,
    columns: ["number", "network", "ghana_card", "wallet_type", "name", "kyc_tier", "status", "opened", "balance", "agent_number", "merchant_id", "merchant_category"],
  },
  bank_accounts: {
    about: "Customers' bank accounts",
    key: "a.rowid",
    sql: `SELECT a.rowid AS _key, a.account_no AS account, a.bank, p.ghana_card, a.name, a.status, ${time("a.created_at")} AS opened, a.balance / 100.0 AS balance FROM bank_accounts a LEFT JOIN persons p ON p.id = a.person_id WHERE a.kind = 'personal'`,
    columns: ["account", "bank", "ghana_card", "name", "status", "opened", "balance"],
  },
  calls: {
    about: "The networks' call records",
    key: "c.rowid",
    sql: `SELECT c.rowid AS _key, ${time("c.started_at")} AS started, c.from_msisdn AS caller, c.from_telco AS caller_network, c.to_msisdn AS called, c.to_telco AS called_network, c.status,
        CASE WHEN c.answered_at IS NULL THEN 0 ELSE (c.ended_at - c.answered_at) / 1000 END AS seconds_talked FROM calls c`,
    columns: ["started", "caller", "caller_network", "called", "called_network", "status", "seconds_talked"],
  },
  texts: {
    about: "The networks' text message records: who, when, how long and whether delivered (never what the text said)",
    key: "s.id",
    sql: `SELECT s.id AS _key, ${time("s.at")} AS time, s.kind AS sender_type, s.sender, s.from_telco AS sender_network, s.to_msisdn AS recipient, s.to_telco AS recipient_network, s.parts, s.status FROM sms_log s`,
    // As in a network's own records: who texted whom, when and how long. What a text said is not included.
    columns: ["time", "sender_type", "sender", "sender_network", "recipient", "recipient_network", "parts", "status"],
  },
  complaints: {
    about: "Complaints customers made to customer care",
    key: "k.rowid",
    sql: `SELECT k.rowid AS _key, k.id AS ticket, ${time("k.created_at")} AS opened, k.telco AS network, k.msisdn AS number, k.category, k.description, k.channel, k.status, k.txn_id AS transaction_id, k.resolution FROM tickets k`,
    columns: ["ticket", "opened", "network", "number", "category", "description", "channel", "status", "transaction_id", "resolution"],
  },
};

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One file as CSV text, a few thousand rows at a time. */
export function* datasetCsv(w: World, name: string, withAnswers = true): Generator<string> {
  const f = DATASET_FILES[name];
  const columns = withAnswers ? f.columns : f.columns.filter((c) => !f.answers?.includes(c));
  yield columns.join(",") + "\n";
  const where = /\bWHERE\b/.test(f.sql.slice(f.sql.lastIndexOf("FROM"))) ? "AND" : "WHERE";
  const page = w.db.prepare(`${f.sql} ${where} ${f.key} > ? ORDER BY ${f.key} LIMIT 4000`);
  let after = 0;
  for (;;) {
    const rows = page.all(after) as Record<string, unknown>[];
    if (!rows.length) return;
    yield rows.map((r) => columns.map((c) => cell(r[c])).join(",")).join("\n") + "\n";
    after = Number(rows[rows.length - 1]._key);
    if (rows.length < 4000) return;
  }
}

export const datasetRows = (w: World, name: string) => Number((w.db.prepare(`SELECT COUNT(*) AS n FROM (${DATASET_FILES[name].sql})`).get() as { n: number }).n);
