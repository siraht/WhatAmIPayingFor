import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

interface CandidateRow {
  merchant_display: string;
  cadence: string;
  typical_amount_minor: number;
  first_seen_date: string;
  last_seen_date: string;
  predicted_next_date: string;
  confidence: number;
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const in7Days = new Date(today.getTime());
in7Days.setUTCDate(in7Days.getUTCDate() + 7);

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

const categoryFor = (merchantDisplay: string): string => {
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

const outputPath = resolve(process.argv[2] ?? "exports/recurring_merchants.csv");
const dbPath = resolve(process.argv[3] ?? `${homedir()}/.fintrack/fintrack.db`);

const db = new Database(dbPath, { readonly: true });
const rows = db
  .query(
    `SELECT merchant_display, cadence, typical_amount_minor, first_seen_date,
            last_seen_date, predicted_next_date, confidence
     FROM recurring_candidate
     ORDER BY first_seen_date DESC, merchant_display ASC`
  )
  .all() as CandidateRow[];

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
for (const row of rows) {
  let next = new Date(`${row.predicted_next_date}T00:00:00Z`);
  let guard = 0;
  while (next < today && guard < 800) {
    next = advanceCadence(next, row.cadence);
    guard += 1;
  }

  const flag = next <= in7Days ? "📅" : "";
  const cadenceCosts = cadenceCostColumns(row.cadence, row.typical_amount_minor);
  const monthlyEquivalent = minorToUsd(monthlyEquivalentMinor(row.cadence, row.typical_amount_minor));

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
    row.merchant_display,
  ].map((value) => csvEscape(String(value)));

  lines.push(record.join(","));
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");

process.stdout.write(`${outputPath}\n`);
process.stdout.write(`rows=${rows.length}\n`);
