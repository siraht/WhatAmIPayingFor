import type { FintrackDb } from "../db";
import { monthRange } from "../utils/time";

export type SpendGroupBy = "merchant" | "category" | "account";

export interface SpendRow {
  key: string;
  total_minor: number;
  txn_count: number;
}

export interface SpendReport {
  month: string;
  groupBy: SpendGroupBy;
  rows: SpendRow[];
  totalMinor: number;
}

const columnForGroupBy = (groupBy: SpendGroupBy): string => {
  if (groupBy === "category") {
    return "COALESCE(category_name, 'Uncategorized')";
  }
  if (groupBy === "account") {
    return "COALESCE(account_name, 'Unknown account')";
  }
  return "COALESCE(merchant_canonical, merchant_raw, 'Unknown merchant')";
};

export const reportSpend = (db: FintrackDb, month: string, groupBy: SpendGroupBy): SpendReport => {
  const range = monthRange(month);
  const keyColumn = columnForGroupBy(groupBy);

  const rows = db.db
    .query(
      `SELECT ${keyColumn} AS key,
              SUM(amount_minor) AS total_minor,
              COUNT(*) AS txn_count
       FROM normalized_transaction
       WHERE include_in_spend = 1
         AND txn_date >= ?
         AND txn_date <= ?
       GROUP BY ${keyColumn}
       ORDER BY total_minor DESC, key ASC`
    )
    .all(range.start, range.end) as SpendRow[];

  const totalMinor = rows.reduce((sum, row) => sum + row.total_minor, 0);

  return {
    month,
    groupBy,
    rows,
    totalMinor,
  };
};
