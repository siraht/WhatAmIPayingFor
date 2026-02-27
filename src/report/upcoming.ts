import type { FintrackDb } from "../db";
import { diffDays, parseIsoDate } from "../utils/time";
import { cadenceIntervalDays, isInactiveByCadence } from "./recurring-activity";

interface CandidateRow {
  id: number;
  merchant_key: string;
  merchant_display: string;
  cadence: string;
  typical_amount_minor: number;
  currency: string;
  last_seen_date: string;
  predicted_next_date: string;
  confidence: number;
  reason_codes: string;
}

export interface UpcomingRow {
  date: string;
  merchant: string;
  merchantKey: string;
  amountMinor: number;
  currency: string;
  confidence: number;
  candidateId: number;
  reasonCodes: string[];
}

export interface UpcomingReport {
  fromDate: string;
  toDate: string;
  days: number;
  rows: UpcomingRow[];
  totalsByDay: Array<{ date: string; totalMinor: number }>;
  totalsByWeek: Array<{ weekStart: string; totalMinor: number }>;
}

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addMonths = (date: Date, months: number): Date => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(year, month + months, 1));
  const end = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, end));
  return next;
};

const advanceCadence = (date: Date, cadence: string): Date => {
  switch (cadence) {
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "every_4_weeks":
      return addDays(date, 28);
    case "monthly":
      return addMonths(date, 1);
    case "quarterly":
      return addMonths(date, 3);
    case "yearly":
      return addMonths(date, 12);
    default:
      return addMonths(date, 1);
  }
};

const isStaleForForecast = (candidate: CandidateRow, fromDate: string): boolean => {
  if (isInactiveByCadence(candidate.last_seen_date, candidate.cadence, fromDate, 2)) {
    return true;
  }
  if (candidate.predicted_next_date >= fromDate) {
    return false;
  }
  const daysSinceLastSeen = Math.max(0, diffDays(fromDate, candidate.last_seen_date));
  return daysSinceLastSeen > cadenceIntervalDays(candidate.cadence) * 3;
};

const mondayOfWeek = (isoDate: string): string => {
  const date = parseIsoDate(isoDate);
  const weekday = date.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + delta);
  return toIsoDate(date);
};

export const reportUpcoming = (db: FintrackDb, days: number, minConfidence: number): UpcomingReport => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const fromDate = toIsoDate(today);
  const horizon = addDays(today, days);
  const toDate = toIsoDate(horizon);

  const candidates = db.db
    .query(
      `SELECT id, merchant_key, merchant_display, cadence,
              typical_amount_minor, currency, last_seen_date, predicted_next_date,
              confidence, reason_codes
       FROM recurring_candidate
       WHERE confidence >= ?`
    )
    .all(minConfidence) as CandidateRow[];

  const rows: UpcomingRow[] = [];
  const maxIterations = Math.max(64, Math.ceil(days / 7) + 8);
  for (const candidate of candidates) {
    if (isStaleForForecast(candidate, fromDate)) {
      continue;
    }
    let cursor = parseIsoDate(candidate.predicted_next_date);
    const endMs = horizon.getTime();
    let guard = 0;
    while (cursor.getTime() <= endMs && guard < maxIterations) {
      guard += 1;
      if (cursor.getTime() >= today.getTime()) {
        rows.push({
          date: toIsoDate(cursor),
          merchant: candidate.merchant_display,
          merchantKey: candidate.merchant_key,
          amountMinor: candidate.typical_amount_minor,
          currency: candidate.currency,
          confidence: candidate.confidence,
          candidateId: candidate.id,
          reasonCodes: JSON.parse(candidate.reason_codes) as string[],
        });
      }
      cursor = advanceCadence(cursor, candidate.cadence);
    }
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    if (a.merchantKey !== b.merchantKey) {
      return a.merchantKey.localeCompare(b.merchantKey);
    }
    if (a.amountMinor !== b.amountMinor) {
      return a.amountMinor - b.amountMinor;
    }
    return a.candidateId - b.candidateId;
  });

  const totalsByDayMap = new Map<string, number>();
  const totalsByWeekMap = new Map<string, number>();
  for (const row of rows) {
    totalsByDayMap.set(row.date, (totalsByDayMap.get(row.date) ?? 0) + row.amountMinor);
    const week = mondayOfWeek(row.date);
    totalsByWeekMap.set(week, (totalsByWeekMap.get(week) ?? 0) + row.amountMinor);
  }

  const totalsByDay = Array.from(totalsByDayMap.entries())
    .map(([date, totalMinor]) => ({ date, totalMinor }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalsByWeek = Array.from(totalsByWeekMap.entries())
    .map(([weekStart, totalMinor]) => ({ weekStart, totalMinor }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return {
    fromDate,
    toDate,
    days,
    rows,
    totalsByDay,
    totalsByWeek,
  };
};

export const renderUpcomingVisual = (report: UpcomingReport): string => {
  const lineByDate = new Map<string, number>();
  for (const row of report.rows) {
    lineByDate.set(row.date, (lineByDate.get(row.date) ?? 0) + 1);
  }

  const lines: string[] = [];
  for (const daily of report.totalsByDay) {
    const count = lineByDate.get(daily.date) ?? 0;
    const bars = "#".repeat(Math.min(24, count));
    lines.push(`${daily.date} | ${bars.padEnd(24, ".")} | ${count} charges`);
  }

  return lines.join("\n");
};
