import type { FintrackDb } from "../db";
import { monthRange } from "../utils/time";
import { isInactiveByCadence } from "./recurring-activity";

export interface SubscriptionsReportOptions {
  month: string;
  minConfidence: number;
  includeUsageBased: boolean;
}

export interface SubscriptionRow {
  merchant: string;
  merchantKey: string;
  cadence: string;
  typicalAmountMinor: number;
  currency: string;
  lastChargeDate: string;
  nextChargeDate: string;
  confidence: number;
  isUsageBased: boolean;
  reasonCodes: string[];
}

export interface SubscriptionsReport {
  month: string;
  minConfidence: number;
  rows: SubscriptionRow[];
}

export const reportSubscriptions = (
  db: FintrackDb,
  options: SubscriptionsReportOptions
): SubscriptionsReport => {
  const range = monthRange(options.month);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString().slice(0, 10);

  const rows = db.db
    .query(
      `SELECT merchant_display, merchant_key, cadence, typical_amount_minor,
              currency, last_seen_date, predicted_next_date,
              confidence, is_usage_based, reason_codes
       FROM recurring_candidate
       WHERE confidence >= ?
         AND first_seen_date <= ?
         AND (
           (last_seen_date BETWEEN ? AND ?)
           OR (predicted_next_date BETWEEN ? AND ?)
         )
       ORDER BY confidence DESC, merchant_key ASC`
    )
    .all(
      options.minConfidence,
      range.end,
      range.start,
      range.end,
      range.start,
      range.end
    ) as Array<{
    merchant_display: string;
    merchant_key: string;
    cadence: string;
    typical_amount_minor: number;
    currency: string;
    last_seen_date: string;
    predicted_next_date: string;
    confidence: number;
    is_usage_based: number;
    reason_codes: string;
  }>;

  const mapped = rows
    .map((row) => ({
      merchant: row.merchant_display,
      merchantKey: row.merchant_key,
      cadence: row.cadence,
      typicalAmountMinor: row.typical_amount_minor,
      currency: row.currency,
      lastChargeDate: row.last_seen_date,
      nextChargeDate: row.predicted_next_date,
      confidence: row.confidence,
      isUsageBased: row.is_usage_based === 1,
      reasonCodes: JSON.parse(row.reason_codes) as string[],
    }))
    .filter((row) => !isInactiveByCadence(row.lastChargeDate, row.cadence, todayIso, 2))
    .filter((row) => options.includeUsageBased || !row.isUsageBased);

  return {
    month: options.month,
    minConfidence: options.minConfidence,
    rows: mapped,
  };
};
