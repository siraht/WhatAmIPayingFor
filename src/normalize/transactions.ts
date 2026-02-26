import type { FintrackDb } from "../db";
import type { RulesIndex } from "../rules";
import { milliunitsToMinor } from "../utils/money";
import { merchantKey } from "../utils/text";
import { isoNow } from "../utils/time";

const REFUND_RX = /(refund|reimburse|reversal|chargeback)/i;
const USAGE_RX = /(utility|meter|usage|kwh|gb|data|electric|water|gas)/i;

interface RawTxn {
  ynab_transaction_id: string;
  budget_id: string;
  date: string;
  amount_milliunits: number;
  payee_name: string | null;
  memo: string | null;
  transfer_account_id: string | null;
  debt_transaction_type: string | null;
  category_name: string | null;
  account_name: string | null;
  deleted: number;
  updated_at: string;
  raw_json: string;
}

export interface NormalizeTransactionsResult {
  processed: number;
  eligible: number;
  excluded: number;
}

const applyAlias = (merchantRaw: string, rules: RulesIndex): { canonical: string; key: string } => {
  const rawKey = merchantKey(merchantRaw);
  const aliased = rules.aliasByRawKey.get(rawKey);
  const canonical = aliased ?? merchantRaw;
  return {
    canonical,
    key: merchantKey(canonical),
  };
};

export const normalizeTransactions = (
  db: FintrackDb,
  currency: string,
  rules: RulesIndex
): NormalizeTransactionsResult => {
  const rows = db.db
    .query(
      `SELECT ynab_transaction_id, budget_id, date, amount_milliunits, payee_name, memo,
              transfer_account_id, debt_transaction_type, category_name, account_name,
              deleted, updated_at, raw_json
       FROM raw_ynab_transaction`
    )
    .all() as RawTxn[];

  const upsert = db.db.query(
    `INSERT INTO normalized_transaction (
      ynab_transaction_id, budget_id, txn_date,
      merchant_raw, merchant_canonical, merchant_key,
      amount_minor, currency, account_name, category_name,
      include_in_spend, eligibility_status, eligibility_reasons,
      is_outflow, is_usage_based, source_updated_at, normalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ynab_transaction_id) DO UPDATE SET
      budget_id = excluded.budget_id,
      txn_date = excluded.txn_date,
      merchant_raw = excluded.merchant_raw,
      merchant_canonical = excluded.merchant_canonical,
      merchant_key = excluded.merchant_key,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      account_name = excluded.account_name,
      category_name = excluded.category_name,
      include_in_spend = excluded.include_in_spend,
      eligibility_status = excluded.eligibility_status,
      eligibility_reasons = excluded.eligibility_reasons,
      is_outflow = excluded.is_outflow,
      is_usage_based = excluded.is_usage_based,
      source_updated_at = excluded.source_updated_at,
      normalized_at = excluded.normalized_at`
  );

  let eligible = 0;
  let excluded = 0;

  const tx = db.db.transaction(() => {
    for (const row of rows) {
      const parsed = JSON.parse(row.raw_json) as { subtransactions?: unknown[] };
      const hasSubtransactions = Array.isArray(parsed.subtransactions) && parsed.subtransactions.length > 0;

      const merchantRaw = row.payee_name || row.category_name || row.account_name || "Unknown";
      const canonical = applyAlias(merchantRaw, rules);

      const reasons: string[] = [];
      let includeInSpend = 1;

      const isOutflow = row.amount_milliunits < 0 ? 1 : 0;
      if (!isOutflow) {
        includeInSpend = 0;
        reasons.push("R_NOT_OUTFLOW");
      }

      if (row.deleted) {
        includeInSpend = 0;
        reasons.push("R_DELETED");
      }

      if (row.transfer_account_id) {
        includeInSpend = 0;
        reasons.push("R_TRANSFER");
      }

      if ((row.debt_transaction_type || "").toLowerCase() === "payment") {
        includeInSpend = 0;
        reasons.push("R_CREDIT_CARD_PAYMENT");
      }

      if (REFUND_RX.test(`${row.memo || ""} ${merchantRaw}`)) {
        includeInSpend = 0;
        reasons.push("R_REFUND_FLOW");
      }

      if (hasSubtransactions) {
        reasons.push("R_HAS_SUBTRANSACTIONS_PARENT_ONLY");
      }

      const usageSignal = USAGE_RX.test(`${row.memo || ""} ${row.category_name || ""}`) ? 1 : 0;

      if (includeInSpend) {
        eligible += 1;
      } else {
        excluded += 1;
      }

      upsert.run(
        row.ynab_transaction_id,
        row.budget_id,
        row.date,
        merchantRaw,
        canonical.canonical,
        canonical.key,
        milliunitsToMinor(row.amount_milliunits),
        currency,
        row.account_name,
        row.category_name,
        includeInSpend,
        includeInSpend ? "eligible" : "excluded",
        JSON.stringify(reasons),
        isOutflow,
        usageSignal,
        row.updated_at,
        isoNow()
      );
    }
  });

  tx();

  return {
    processed: rows.length,
    eligible,
    excluded,
  };
};
