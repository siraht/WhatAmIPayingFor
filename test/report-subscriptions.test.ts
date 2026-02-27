import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { reportSubscriptions } from "../src/report/subscriptions";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("reportSubscriptions", () => {
  test("limits rows to merchants with in-month last or next charge", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO recurring_candidate (
        merchant_key, merchant_display, cadence, typical_amount_minor,
        currency, occurrences_count, first_seen_date, last_seen_date,
        predicted_next_date, confidence, is_usage_based, reason_codes,
        source_evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    insert.run(
      "charged-in-month",
      "Charged In Month",
      "monthly",
      1000,
      "USD",
      8,
      "2025-01-01",
      "2026-02-05",
      "2026-03-05",
      0.9,
      0,
      "[]",
      "{}"
    );
    insert.run(
      "next-in-month",
      "Next In Month",
      "monthly",
      2000,
      "USD",
      8,
      "2025-01-01",
      "2026-01-15",
      "2026-02-15",
      0.85,
      0,
      "[]",
      "{}"
    );
    insert.run(
      "future-only",
      "Future Only",
      "yearly",
      3000,
      "USD",
      2,
      "2024-01-01",
      "2026-01-05",
      "2026-12-05",
      0.95,
      0,
      "[]",
      "{}"
    );

    const report = reportSubscriptions(db, {
      month: "2026-02",
      minConfidence: 0.1,
      includeUsageBased: true,
    });

    const keys = report.rows.map((row) => row.merchantKey).sort();
    expect(keys).toEqual(["charged-in-month", "next-in-month"]);
  });

  test("hides monthly rows inactive for over 8 weeks", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const staleLast = new Date(today);
    staleLast.setUTCDate(staleLast.getUTCDate() - 70);
    const freshLast = new Date(today);
    freshLast.setUTCDate(freshLast.getUTCDate() - 20);
    const nextSoon = new Date(today);
    nextSoon.setUTCDate(nextSoon.getUTCDate() + 2);
    const month = nextSoon.toISOString().slice(0, 7);

    const insert = db.db.query(
      `INSERT INTO recurring_candidate (
        merchant_key, merchant_display, cadence, typical_amount_minor,
        currency, occurrences_count, first_seen_date, last_seen_date,
        predicted_next_date, confidence, is_usage_based, reason_codes,
        source_evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    insert.run(
      "stale-monthly",
      "Stale Monthly",
      "monthly",
      1000,
      "USD",
      6,
      "2025-01-01",
      staleLast.toISOString().slice(0, 10),
      nextSoon.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );
    insert.run(
      "fresh-monthly",
      "Fresh Monthly",
      "monthly",
      1000,
      "USD",
      6,
      "2025-01-01",
      freshLast.toISOString().slice(0, 10),
      nextSoon.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );

    const report = reportSubscriptions(db, {
      month,
      minConfidence: 0.1,
      includeUsageBased: true,
    });

    const keys = report.rows.map((row) => row.merchantKey).sort();
    expect(keys).toEqual(["fresh-monthly"]);
  });
});
