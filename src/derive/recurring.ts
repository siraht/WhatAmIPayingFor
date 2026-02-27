import type { FintrackDb } from "../db";
import type { RulesIndex } from "../rules";
import { clampDayToMonth, diffDays, isoNow, parseIsoDate } from "../utils/time";
import { merchantKey } from "../utils/text";

interface TxnRowRaw {
  ynab_transaction_id: string;
  raw_merchant_key: string;
  merchant_canonical: string;
  txn_date: string;
  amount_minor: number;
  currency: string;
  category_name: string | null;
  is_usage_based: number;
}

interface TxnRow extends TxnRowRaw {
  merchant_key: string;
}

interface ScheduledRow {
  payee_name: string | null;
  frequency: string | null;
  amount_milliunits: number | null;
  deleted: number;
}

type Cadence = "weekly" | "biweekly" | "every_4_weeks" | "monthly" | "quarterly" | "yearly" | "unknown";

const median = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const mean = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values: number[]): number => {
  if (values.length <= 1) {
    return 0;
  }
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const classifyCadence = (medianInterval: number, dayOfMonthVariance: number): Cadence => {
  if (medianInterval >= 6 && medianInterval <= 8) {
    return "weekly";
  }
  if (medianInterval >= 13 && medianInterval <= 15) {
    return "biweekly";
  }
  if (medianInterval >= 26 && medianInterval <= 29) {
    return dayOfMonthVariance <= 3 ? "monthly" : "every_4_weeks";
  }
  if (medianInterval >= 30 && medianInterval <= 32) {
    return "monthly";
  }
  if (medianInterval >= 80 && medianInterval <= 100) {
    return "quarterly";
  }
  if (medianInterval >= 350 && medianInterval <= 380) {
    return "yearly";
  }
  return "unknown";
};

const requiredOccurrences = (cadence: Cadence): { minCount: number; maxWindowDays: number } => {
  switch (cadence) {
    case "weekly":
    case "biweekly":
    case "every_4_weeks":
    case "monthly":
      return { minCount: 3, maxWindowDays: 180 };
    case "quarterly":
      return { minCount: 2, maxWindowDays: 365 };
    case "yearly":
      return { minCount: 2, maxWindowDays: 730 };
    default:
      return { minCount: 3, maxWindowDays: 365 };
  }
};

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addMonthsPreserveDay = (date: Date, months: number): Date => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let nextMonth = month + months;
  let nextYear = year + Math.floor((nextMonth - 1) / 12);
  nextMonth = ((nextMonth - 1) % 12) + 1;
  if (nextMonth <= 0) {
    nextYear -= 1;
    nextMonth += 12;
  }

  const clampedDay = clampDayToMonth(nextYear, nextMonth, day);
  return new Date(Date.UTC(nextYear, nextMonth - 1, clampedDay));
};

const predictNextDate = (lastDateIso: string, cadence: Cadence, medianIntervalDays: number): string => {
  const lastDate = parseIsoDate(lastDateIso);
  let next: Date;

  if (cadence === "weekly") {
    next = addDays(lastDate, 7);
  } else if (cadence === "biweekly") {
    next = addDays(lastDate, 14);
  } else if (cadence === "every_4_weeks") {
    next = addDays(lastDate, 28);
  } else if (cadence === "monthly") {
    next = addMonthsPreserveDay(lastDate, 1);
  } else if (cadence === "quarterly") {
    next = addMonthsPreserveDay(lastDate, 3);
  } else if (cadence === "yearly") {
    const month = lastDate.getUTCMonth() + 1;
    const day = lastDate.getUTCDate();
    const nextYear = lastDate.getUTCFullYear() + 1;
    const adjustedDay = month === 2 && day === 29 ? 28 : clampDayToMonth(nextYear, month, day);
    next = new Date(Date.UTC(nextYear, month - 1, adjustedDay));
  } else {
    next = addDays(lastDate, Math.max(1, Math.round(medianIntervalDays)));
  }

  return next.toISOString().slice(0, 10);
};

const isDiscretionaryMerchant = (merchantKey: string): boolean => {
  return /(coffee|restaurant|uber|lyft|doordash|amazon|target|walmart)/i.test(merchantKey);
};

const DOMAIN_SUFFIXES = new Set([
  "com",
  "net",
  "org",
  "io",
  "co",
  "uk",
]);

const normalizeRecurringMerchantKey = (input: string): string => {
  const base = merchantKey(input);
  if (!base) {
    return base;
  }

  let tokens = base.split(" ").filter(Boolean);
  while (tokens.length > 1 && /^(rch|recurring|charge|payment|purchase|pos)$/.test(tokens[0])) {
    tokens = tokens.slice(1);
  }
  while (tokens.length > 1 && DOMAIN_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }

  if (tokens.length === 0) {
    return base;
  }

  if (tokens.length >= 2 && tokens[0].length <= 2) {
    tokens = tokens.slice(1);
  }

  return tokens.join(" ");
};

const toTitleCase = (value: string): string => {
  return value
    .split(" ")
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join(" ");
};

const preferredMerchantDisplay = (merchantKeyNorm: string, rows: TxnRow[]): string => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = (row.merchant_canonical || "").trim();
    if (!label) {
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const scored = Array.from(counts.entries()).map(([label, count]) => {
    let score = count * 10;
    if (!/\./.test(label)) {
      score += 3;
    }
    if (!/^rch[\s.-]/i.test(label)) {
      score += 2;
    }
    const norm = normalizeRecurringMerchantKey(label);
    if (norm === merchantKeyNorm) {
      score += 4;
    }
    if (/\s/.test(label)) {
      score += 1;
    }
    return { label, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.label.length !== b.label.length) {
      return a.label.length - b.label.length;
    }
    return a.label.localeCompare(b.label);
  });

  return scored[0]?.label ?? toTitleCase(merchantKeyNorm || "unknown");
};

const isGroceryOrFuelFoodMerchant = (merchantKey: string, rows: TxnRow[]): boolean => {
  const merchantHit = [
    /whole\s+foods/i,
    /trader\s+joe/i,
    /natural\s+grocers/i,
    /\bh\s*e\s*b\b/i,
    /safeway/i,
    /king\s+soopers/i,
    /costco/i,
    /walmart\s+grocery/i,
    /kroger/i,
    /maverik/i,
    /chevron/i,
    /\bshell\b/i,
    /\bexxon\b/i,
    /\bbp\b/i,
    /7\s*eleven/i,
    /circle\s*k/i,
    /market/i,
    /bento/i,
    /taco/i,
    /torchy/i,
  ].some((pattern) => pattern.test(merchantKey));

  if (merchantHit) {
    return true;
  }

  const categorySignals = rows
    .map((row) => (row.category_name || "").toLowerCase())
    .filter(Boolean);
  if (categorySignals.length === 0) {
    return false;
  }

  const categoryHits = categorySignals.filter((value) =>
    /(grocery|grocer|dining|restaurant|food|fuel|gas|market)/i.test(value)
  ).length;
  return categoryHits / categorySignals.length >= 0.5;
};

export interface RecomputeRecurringResult {
  candidates: number;
  occurrences: number;
}

export const recomputeRecurring = (db: FintrackDb, rules: RulesIndex): RecomputeRecurringResult => {
  const txRowsRaw = db.db
    .query(
      `SELECT ynab_transaction_id, merchant_key AS raw_merchant_key, merchant_canonical, txn_date,
              amount_minor, currency, category_name, is_usage_based
       FROM normalized_transaction
       WHERE include_in_spend = 1 AND is_outflow = 1
       ORDER BY merchant_key, txn_date`
    )
    .all() as TxnRowRaw[];
  const txRows = txRowsRaw.map((row) => ({
    ...row,
    merchant_key: normalizeRecurringMerchantKey(row.raw_merchant_key),
  }));

  const winnerRows = db.db
    .query(
      `SELECT nt.merchant_key AS merchant_key, COUNT(*) AS match_count
       FROM transaction_email_match tem
       JOIN normalized_transaction nt ON nt.ynab_transaction_id = tem.ynab_transaction_id
       WHERE tem.is_winner = 1
       GROUP BY nt.merchant_key`
    )
    .all() as Array<{ merchant_key: string; match_count: number }>;
  const emailMatches = new Map<string, number>();
  for (const row of winnerRows) {
    const key = normalizeRecurringMerchantKey(row.merchant_key);
    emailMatches.set(key, (emailMatches.get(key) ?? 0) + row.match_count);
  }

  const scheduledRows = db.db
    .query(
      `SELECT payee_name, frequency, amount_milliunits, deleted
       FROM raw_ynab_scheduled_transaction`
    )
    .all() as ScheduledRow[];

  const scheduledByMerchant = new Map<string, ScheduledRow[]>();
  for (const row of scheduledRows) {
    if (row.deleted) {
      continue;
    }
    const rawKey = merchantKey(row.payee_name || "unknown");
    const aliased = rules.aliasByRawKey.get(rawKey);
    const key = normalizeRecurringMerchantKey(merchantKey(aliased ?? rawKey));
    if (!key) {
      continue;
    }
    const bucket = scheduledByMerchant.get(key) ?? [];
    bucket.push(row);
    scheduledByMerchant.set(key, bucket);
  }

  const grouped = new Map<string, TxnRow[]>();
  for (const row of txRows) {
    if (!row.merchant_key) {
      continue;
    }
    const bucket = grouped.get(row.merchant_key) ?? [];
    bucket.push(row);
    grouped.set(row.merchant_key, bucket);
  }

  let candidateCount = 0;
  let occurrenceCount = 0;

  const tx = db.db.transaction(() => {
    db.db.exec("DELETE FROM recurring_occurrence;");
    db.db.exec("DELETE FROM recurring_candidate;");

    const insertCandidate = db.db.query(
      `INSERT INTO recurring_candidate (
        merchant_key, merchant_display, cadence, typical_amount_minor,
        currency, occurrences_count, first_seen_date, last_seen_date,
        predicted_next_date, confidence, is_usage_based, reason_codes,
        source_evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertOccurrence = db.db.query(
      `INSERT INTO recurring_occurrence (
        recurring_candidate_id, ynab_transaction_id, txn_date, amount_minor, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );

    for (const [merchant, rows] of grouped.entries()) {
      rows.sort((a, b) => a.txn_date.localeCompare(b.txn_date));
      const reasons: string[] = [];

      const ignoreRule =
        rules.ignore.has(merchant) || rows.some((row) => rules.ignore.has(row.raw_merchant_key));
      const forceRule =
        rules.force.has(merchant) || rows.some((row) => rules.force.has(row.raw_merchant_key));

      if (ignoreRule && !forceRule) {
        continue;
      }
      if (!forceRule && isGroceryOrFuelFoodMerchant(merchant, rows)) {
        continue;
      }

      const amounts = rows.map((row) => row.amount_minor);
      const amountSpread = Math.max(...amounts) - Math.min(...amounts);
      if (!forceRule && amountSpread > 500) {
        continue;
      }
      const dates = rows.map((row) => row.txn_date);
      const intervals: number[] = [];
      for (let i = 1; i < dates.length; i += 1) {
        intervals.push(Math.abs(diffDays(dates[i], dates[i - 1])));
      }

      const medianInterval = intervals.length > 0 ? median(intervals) : 0;
      const dayValues = dates.map((date) => Number(date.slice(8, 10)));
      const dayVariance = stddev(dayValues);
      const cadence = classifyCadence(medianInterval, dayVariance);

      if (cadence === "unknown" && !forceRule) {
        continue;
      }

      const ruleReq = requiredOccurrences(cadence);
      const lastDate = dates[dates.length - 1];
      const recentWindowCount = rows.filter(
        (row) => Math.abs(diffDays(lastDate, row.txn_date)) <= ruleReq.maxWindowDays
      ).length;

      const scheduledSignal = scheduledByMerchant.has(merchant);
      const sparseAllowed = scheduledSignal && rows.length >= Math.max(1, ruleReq.minCount - 1);
      const enoughOccurrences =
        recentWindowCount >= ruleReq.minCount;

      if (!enoughOccurrences && !sparseAllowed && !forceRule) {
        continue;
      }

      if (enoughOccurrences) {
        reasons.push("R_OCCURRENCE_WINDOW_OK");
      } else if (sparseAllowed) {
        reasons.push("R_SPARSE_HISTORY_SCHEDULED_EXCEPTION");
      }

      if (
        cadence === "weekly" ||
        cadence === "monthly" ||
        cadence === "quarterly" ||
        cadence === "yearly" ||
        cadence === "every_4_weeks" ||
        cadence === "biweekly"
      ) {
        reasons.push(`R_INTERVAL_${cadence.toUpperCase()}`);
      }

      const amountMedian = median(amounts);
      const amountCv = amountMedian > 0 ? stddev(amounts) / amountMedian : 0;
      let isUsageBased = amountCv > 0.2 ? 1 : 0;
      if (rows.some((row) => row.is_usage_based === 1)) {
        isUsageBased = 1;
      }

      if (isUsageBased) {
        reasons.push("R_USAGE_BASED_VARIANCE");
      } else {
        reasons.push("R_AMOUNT_STABLE");
      }
      reasons.push("R_AMOUNT_SPREAD_WITHIN_5USD");

      const emailMatchCount = emailMatches.get(merchant) ?? 0;
      if (emailMatchCount > 0) {
        reasons.push("R_MATCHED_EMAIL_EVIDENCE");
      }

      if (scheduledSignal) {
        reasons.push("R_MATCHED_YNAB_SCHEDULED");
      }

      const intervalCv = intervals.length > 1 && medianInterval > 0 ? stddev(intervals) / medianInterval : 0.25;
      let confidence = 0.2;
      confidence += Math.max(0, 0.35 * (1 - Math.min(1, intervalCv * 2)));
      confidence += isUsageBased ? 0.05 : 0.2;
      confidence += Math.min(0.15, (emailMatchCount / Math.max(1, rows.length)) * 0.2);
      if (scheduledSignal) {
        confidence += 0.15;
      }
      if (isDiscretionaryMerchant(merchant)) {
        confidence -= 0.08;
        reasons.push("R_DISCRETIONARY_PRIOR_PENALTY");
      }

      if (scheduledSignal && emailMatchCount === 0) {
        confidence = Math.min(confidence, 0.93);
      }
      if (emailMatchCount === 0) {
        confidence = Math.min(confidence, 0.89);
      }
      if (!enoughOccurrences && sparseAllowed) {
        confidence = Math.min(confidence, 0.79);
      }

      if (forceRule) {
        confidence = Math.max(confidence, 0.8);
        reasons.push("R_RULE_FORCED");
      }
      if (ignoreRule) {
        confidence = 0;
        reasons.push("R_RULE_IGNORED");
      }

      confidence = Number(Math.max(0, Math.min(0.99, confidence)).toFixed(4));

      const firstSeenDate = dates[0];
      const lastSeenDate = dates[dates.length - 1];
      const predictedNextDate = predictNextDate(lastSeenDate, cadence, medianInterval || 30);

      const inserted = insertCandidate.run(
        merchant,
        preferredMerchantDisplay(merchant, rows),
        cadence,
        Math.round(amountMedian),
        rows[0].currency,
        rows.length,
        firstSeenDate,
        lastSeenDate,
        predictedNextDate,
        confidence,
        isUsageBased,
        JSON.stringify(Array.from(new Set(reasons))),
        JSON.stringify({
          interval_median_days: medianInterval,
          interval_cv: Number(intervalCv.toFixed(4)),
          amount_cv: Number(amountCv.toFixed(4)),
          email_match_count: emailMatchCount,
          scheduled_signal: scheduledSignal,
          sparse_allowed: sparseAllowed,
        }),
        isoNow()
      ) as { lastInsertRowid: number };

      candidateCount += 1;
      const candidateId = Number(inserted.lastInsertRowid);

      for (const row of rows) {
        insertOccurrence.run(candidateId, row.ynab_transaction_id, row.txn_date, row.amount_minor, isoNow());
        occurrenceCount += 1;
      }
    }
  });

  tx();

  return {
    candidates: candidateCount,
    occurrences: occurrenceCount,
  };
};
