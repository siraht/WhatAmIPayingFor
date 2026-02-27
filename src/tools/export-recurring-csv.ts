import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { diffDays } from "../utils/time";
import { cadenceIntervalDays, isInactiveByCadence } from "../report/recurring-activity";

export interface CandidateRow {
  merchant_display: string;
  cadence: string;
  typical_amount_minor: number;
  first_seen_date: string;
  last_seen_date: string;
  predicted_next_date: string;
  confidence: number;
}

interface MergedCandidateRow extends CandidateRow {
  source_merchant_names: string[];
}

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const monthEnd = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, monthEnd));
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

const minorToUsd = (minor: number): string => (minor / 100).toFixed(2);

const cadenceCostColumns = (
  cadence: string,
  typicalMinor: number
): Record<string, string> => {
  const blank = {
    weekly_usd: "",
    biweekly_usd: "",
    every_4_weeks_usd: "",
    monthly_usd: "",
    quarterly_usd: "",
    yearly_usd: "",
  };

  if (cadence === "weekly") {
    blank.weekly_usd = minorToUsd(typicalMinor);
  } else if (cadence === "biweekly") {
    blank.biweekly_usd = minorToUsd(typicalMinor);
  } else if (cadence === "every_4_weeks") {
    blank.every_4_weeks_usd = minorToUsd(typicalMinor);
  } else if (cadence === "monthly") {
    blank.monthly_usd = minorToUsd(typicalMinor);
  } else if (cadence === "quarterly") {
    blank.quarterly_usd = minorToUsd(typicalMinor);
  } else if (cadence === "yearly") {
    blank.yearly_usd = minorToUsd(typicalMinor);
  }

  return blank;
};

const monthlyEquivalentMinor = (cadence: string, typicalMinor: number): number => {
  switch (cadence) {
    case "weekly":
      return Math.round(typicalMinor * (52 / 12));
    case "biweekly":
      return Math.round(typicalMinor * (26 / 12));
    case "every_4_weeks":
      return Math.round(typicalMinor * (13 / 12));
    case "monthly":
      return typicalMinor;
    case "quarterly":
      return Math.round(typicalMinor / 3);
    case "yearly":
      return Math.round(typicalMinor / 12);
    default:
      return typicalMinor;
  }
};

export const categoryFor = (merchantDisplay: string): string => {
  const key = merchantDisplay.toLowerCase();
  if (key.includes("comcast")) return "Internet";
  if (key.includes("linode") || key.includes("whatbox") || key.includes("runcloud") || key.includes("mxroute")) {
    return "Hosting/Infra";
  }
  if (
    key.includes("todoist") ||
    key.includes("etesync") ||
    key.includes("plex") ||
    key.includes("accuweather") ||
    key.includes("kagi") ||
    key.includes("manictime") ||
    key.includes("taskade") ||
    key.includes("airtable")
  ) {
    return "Software/SaaS";
  }
  if (
    key.includes("claude") ||
    key.includes("warp") ||
    key.includes("youtube") ||
    key === "x" ||
    key.includes("digital ambition") ||
    key.includes("skool")
  ) {
    return "AI/Tools/Media";
  }
  if (key.includes("united") || key.includes("goldenrule") || key.includes("health")) return "Insurance/Health";
  if (key.includes("state of co") || key.includes("mun crt")) return "Government/Fees";
  if (key.includes("interest")) return "Finance/Interest";
  if (key.includes("ynab")) return "Budgeting";
  return "Other";
};

const displayNameFor = (merchantDisplay: string): string => {
  const key = merchantDisplay.toLowerCase();
  if (key.includes("claude")) return "Anthropic Claude";
  if (key.includes("rch-kagi")) return "Kagi";
  if (key.includes("comcast")) return "Comcast / Xfinity";
  return merchantDisplay;
};

const csvEscape = (value: string): string => {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
};

const normalizeNameTokens = (value: string): string[] => {
  const spaced = value
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!spaced) {
    return [];
  }

  const stop = new Set([
    "rch",
    "recurring",
    "charge",
    "payment",
    "purchase",
    "pos",
    "com",
    "net",
    "org",
    "io",
    "co",
    "uk",
    "inc",
    "llc",
    "ltd",
    "corp",
    "ins",
    "prem",
    "premium",
    "policy",
    "travis",
    "hinton",
  ]);

  return spaced
    .split(" ")
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !stop.has(token));
};

const tokenSimilarity = (a: string, b: string): number => {
  const aTokens = new Set(normalizeNameTokens(a));
  const bTokens = new Set(normalizeNameTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 ? intersection / union : 0;
};

const shouldMergeByName = (a: CandidateRow, b: CandidateRow): boolean => {
  const similarity = tokenSimilarity(a.merchant_display, b.merchant_display);
  return similarity >= 0.5;
};

const isInsuranceLike = (merchantDisplay: string): boolean => {
  const category = categoryFor(merchantDisplay);
  if (category === "Insurance/Health") {
    return true;
  }
  return /(insurance|health|goldenrule|unitedhealth|uhc|uhone)/i.test(merchantDisplay);
};

const shouldMergeByInsuranceHandoff = (earlier: CandidateRow, later: CandidateRow): boolean => {
  if (!isInsuranceLike(earlier.merchant_display) || !isInsuranceLike(later.merchant_display)) {
    return false;
  }
  if (earlier.cadence !== later.cadence) {
    return false;
  }
  const amountDiff = Math.abs(earlier.typical_amount_minor - later.typical_amount_minor);
  if (amountDiff > 200) {
    return false;
  }

  const cadenceDays = cadenceIntervalDays(earlier.cadence);
  const gap = diffDays(later.first_seen_date, earlier.last_seen_date);
  return gap >= -cadenceDays && gap <= cadenceDays * 2;
};

const byFirstSeenAsc = (a: CandidateRow, b: CandidateRow): number => {
  if (a.first_seen_date !== b.first_seen_date) {
    return a.first_seen_date.localeCompare(b.first_seen_date);
  }
  return a.merchant_display.localeCompare(b.merchant_display);
};

const pickRepresentative = (rows: CandidateRow[]): CandidateRow => {
  const sorted = [...rows].sort((a, b) => {
    if (a.last_seen_date !== b.last_seen_date) {
      return b.last_seen_date.localeCompare(a.last_seen_date);
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.merchant_display.localeCompare(b.merchant_display);
  });
  return sorted[0];
};

const medianMinor = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
};

export const mergeLikelyDuplicateCandidates = (rows: CandidateRow[]): MergedCandidateRow[] => {
  const sorted = [...rows].sort(byFirstSeenAsc);
  const groups: CandidateRow[][] = [];

  for (const row of sorted) {
    let merged = false;
    for (const group of groups) {
      const representative = pickRepresentative(group);
      if (row.cadence !== representative.cadence) {
        continue;
      }

      const amountDiff = Math.abs(row.typical_amount_minor - representative.typical_amount_minor);
      if (amountDiff > 500) {
        continue;
      }

      const groupByLastSeen = [...group].sort((a, b) => a.last_seen_date.localeCompare(b.last_seen_date));
      const latestGroupRow = groupByLastSeen[groupByLastSeen.length - 1];
      const earlier = latestGroupRow.last_seen_date <= row.last_seen_date ? latestGroupRow : row;
      const later = earlier === row ? latestGroupRow : row;

      if (shouldMergeByName(representative, row) || shouldMergeByInsuranceHandoff(earlier, later)) {
        group.push(row);
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.push([row]);
    }
  }

  return groups.map((group) => {
    const representative = pickRepresentative(group);
    const names = Array.from(new Set(group.map((row) => row.merchant_display))).sort((a, b) =>
      a.localeCompare(b)
    );
    const firstSeen = group.map((row) => row.first_seen_date).sort()[0];
    const lastSeen = group.map((row) => row.last_seen_date).sort().reverse()[0];

    const byLastSeenDesc = [...group].sort((a, b) => b.last_seen_date.localeCompare(a.last_seen_date));
    const latest = byLastSeenDesc[0];
    return {
      merchant_display: representative.merchant_display,
      cadence: representative.cadence,
      typical_amount_minor: medianMinor(group.map((row) => row.typical_amount_minor)),
      first_seen_date: firstSeen,
      last_seen_date: lastSeen,
      predicted_next_date: latest.predicted_next_date,
      confidence: Math.max(...group.map((row) => row.confidence)),
      source_merchant_names: names,
    };
  });
};

export const filterActiveCandidates = (rows: MergedCandidateRow[], todayIso: string): MergedCandidateRow[] =>
  rows.filter((row) => !isInactiveByCadence(row.last_seen_date, row.cadence, todayIso, 2));

interface CsvBuildResult {
  lines: string[];
  rowCount: number;
}

const buildCsvLines = (rows: CandidateRow[], now = new Date()): CsvBuildResult => {
  const today = new Date(now.getTime());
  today.setUTCHours(0, 0, 0, 0);
  const in7Days = new Date(today.getTime());
  in7Days.setUTCDate(in7Days.getUTCDate() + 7);
  const todayIso = today.toISOString().slice(0, 10);

  const merged = mergeLikelyDuplicateCandidates(rows);
  const active = filterActiveCandidates(merged, todayIso).sort((a, b) => {
    if (a.first_seen_date !== b.first_seen_date) {
      return b.first_seen_date.localeCompare(a.first_seen_date);
    }
    return a.merchant_display.localeCompare(b.merchant_display);
  });

  const header = [
    "flag",
    "merchant",
    "category",
    "cadence",
    "typical_charge_usd",
    "weekly_usd",
    "biweekly_usd",
    "every_4_weeks_usd",
    "monthly_usd",
    "quarterly_usd",
    "yearly_usd",
    "monthly_equivalent_usd",
    "first_seen",
    "last_seen",
    "next_payment",
    "confidence",
    "source_merchant_name",
  ];
  const lines = [header.join(",")];
  for (const row of active) {
    let next = new Date(`${row.predicted_next_date}T00:00:00Z`);
    let guard = 0;
    while (next < today && guard < 800) {
      next = advanceCadence(next, row.cadence);
      guard += 1;
    }

    const flag = next <= in7Days ? "📅" : "";
    const cadenceCosts = cadenceCostColumns(row.cadence, row.typical_amount_minor);
    const monthlyEquivalent = minorToUsd(monthlyEquivalentMinor(row.cadence, row.typical_amount_minor));
    const sourceName = row.source_merchant_names.join(" | ");

    const record = [
      flag,
      displayNameFor(row.merchant_display),
      categoryFor(row.merchant_display),
      row.cadence,
      minorToUsd(row.typical_amount_minor),
      cadenceCosts.weekly_usd,
      cadenceCosts.biweekly_usd,
      cadenceCosts.every_4_weeks_usd,
      cadenceCosts.monthly_usd,
      cadenceCosts.quarterly_usd,
      cadenceCosts.yearly_usd,
      monthlyEquivalent,
      row.first_seen_date,
      row.last_seen_date,
      next.toISOString().slice(0, 10),
      row.confidence.toFixed(3),
      sourceName,
    ].map((value) => csvEscape(String(value)));

    lines.push(record.join(","));
  }

  return {
    lines,
    rowCount: active.length,
  };
};

export const runExportRecurringCsv = (outputPathArg?: string, dbPathArg?: string): CsvBuildResult => {
  const outputPath = resolve(outputPathArg ?? process.argv[2] ?? "exports/recurring_merchants.csv");
  const dbPath = resolve(dbPathArg ?? process.argv[3] ?? `${homedir()}/.fintrack/fintrack.db`);

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query(
      `SELECT merchant_display, cadence, typical_amount_minor, first_seen_date,
              last_seen_date, predicted_next_date, confidence
       FROM recurring_candidate
       ORDER BY first_seen_date DESC, merchant_display ASC`
    )
    .all() as CandidateRow[];

  const result = buildCsvLines(rows);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${result.lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
  process.stdout.write(`rows=${result.rowCount}\n`);
  return result;
};

if (import.meta.main) {
  runExportRecurringCsv();
}
