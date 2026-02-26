export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    sql: `
CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, scope)
);

CREATE TABLE IF NOT EXISTS raw_ynab_transaction (
  ynab_transaction_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  date TEXT NOT NULL,
  amount_milliunits INTEGER NOT NULL,
  payee_name TEXT,
  memo TEXT,
  cleared TEXT,
  approved INTEGER,
  deleted INTEGER,
  transfer_account_id TEXT,
  transfer_transaction_id TEXT,
  parent_transaction_id TEXT,
  category_name TEXT,
  category_id TEXT,
  debt_transaction_type TEXT,
  import_id TEXT,
  flag_color TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_ynab_transaction_budget_date ON raw_ynab_transaction (budget_id, date);
CREATE INDEX IF NOT EXISTS idx_raw_ynab_transaction_payee ON raw_ynab_transaction (payee_name);

CREATE TABLE IF NOT EXISTS raw_ynab_scheduled_transaction (
  ynab_scheduled_transaction_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  date_first TEXT,
  date_next TEXT,
  frequency TEXT,
  amount_milliunits INTEGER,
  payee_name TEXT,
  category_name TEXT,
  deleted INTEGER,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_ynab_scheduled_budget_next ON raw_ynab_scheduled_transaction (budget_id, date_next);

CREATE TABLE IF NOT EXISTS raw_email_purchase (
  message_key TEXT PRIMARY KEY,
  message_id_hash TEXT,
  canonical_email_evidence_id TEXT NOT NULL,
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER,
  uidvalidity TEXT,
  datetime TEXT,
  sender_domain TEXT,
  subject_hash TEXT,
  item_name TEXT,
  item_price_minor INTEGER,
  amount_evidence_type TEXT,
  currency TEXT,
  parse_confidence REAL,
  parse_status TEXT,
  parser_version TEXT,
  raw_metadata_json TEXT,
  inserted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_email_purchase_canonical ON raw_email_purchase (canonical_email_evidence_id);
CREATE INDEX IF NOT EXISTS idx_raw_email_purchase_messageid ON raw_email_purchase (message_id_hash);
CREATE INDEX IF NOT EXISTS idx_raw_email_purchase_datetime ON raw_email_purchase (datetime);

CREATE TABLE IF NOT EXISTS normalized_transaction (
  ynab_transaction_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  txn_date TEXT NOT NULL,
  merchant_raw TEXT,
  merchant_canonical TEXT,
  merchant_key TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  account_name TEXT,
  category_name TEXT,
  include_in_spend INTEGER NOT NULL,
  eligibility_status TEXT NOT NULL,
  eligibility_reasons TEXT NOT NULL,
  is_outflow INTEGER NOT NULL,
  is_usage_based INTEGER NOT NULL,
  source_updated_at TEXT NOT NULL,
  normalized_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_normalized_transaction_date ON normalized_transaction (txn_date);
CREATE INDEX IF NOT EXISTS idx_normalized_transaction_merchant ON normalized_transaction (merchant_key);

CREATE TABLE IF NOT EXISTS normalized_email_purchase (
  canonical_email_evidence_id TEXT PRIMARY KEY,
  datetime TEXT,
  merchant_key TEXT,
  item_name_norm TEXT,
  item_price_minor INTEGER,
  currency TEXT,
  amount_evidence_type TEXT,
  parse_confidence REAL,
  parser_version TEXT,
  normalized_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_normalized_email_datetime ON normalized_email_purchase (datetime);
CREATE INDEX IF NOT EXISTS idx_normalized_email_merchant ON normalized_email_purchase (merchant_key);

CREATE TABLE IF NOT EXISTS transaction_email_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ynab_transaction_id TEXT NOT NULL,
  canonical_email_evidence_id TEXT NOT NULL,
  score REAL NOT NULL,
  reason_codes TEXT NOT NULL,
  is_winner INTEGER NOT NULL,
  matched_at TEXT NOT NULL,
  UNIQUE (ynab_transaction_id, canonical_email_evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_txn_email_match_winner ON transaction_email_match (is_winner, score);

CREATE TABLE IF NOT EXISTS recurring_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_key TEXT NOT NULL UNIQUE,
  merchant_display TEXT NOT NULL,
  cadence TEXT NOT NULL,
  typical_amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  occurrences_count INTEGER NOT NULL,
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  predicted_next_date TEXT NOT NULL,
  confidence REAL NOT NULL,
  is_usage_based INTEGER NOT NULL,
  reason_codes TEXT NOT NULL,
  source_evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recurring_candidate_next ON recurring_candidate (predicted_next_date, confidence);

CREATE TABLE IF NOT EXISTS recurring_occurrence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recurring_candidate_id INTEGER NOT NULL,
  ynab_transaction_id TEXT NOT NULL,
  txn_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (recurring_candidate_id, ynab_transaction_id)
);

CREATE TABLE IF NOT EXISTS rule_alias_merchant (
  raw_key TEXT PRIMARY KEY,
  canonical_merchant TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_ignore_merchant (
  merchant_key TEXT PRIMARY KEY,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_force_subscription (
  merchant_key TEXT PRIMARY KEY,
  reason TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
];
