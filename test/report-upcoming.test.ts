import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { reportUpcoming } from "../src/report/upcoming";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("reportUpcoming", () => {
  test("supports long weekly horizons without truncating near 64 rows", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const nextDate = today.toISOString().slice(0, 10);
    const lastSeen = new Date(today);
    lastSeen.setUTCDate(lastSeen.getUTCDate() - 7);

    db.db
      .query(
        `INSERT INTO recurring_candidate (
          merchant_key, merchant_display, cadence, typical_amount_minor,
          currency, occurrences_count, first_seen_date, last_seen_date,
          predicted_next_date, confidence, is_usage_based, reason_codes,
          source_evidence_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        "weekly-service",
        "Weekly Service",
        "weekly",
        999,
        "USD",
        10,
        "2025-01-01",
        lastSeen.toISOString().slice(0, 10),
        nextDate,
        0.9,
        0,
        "[]",
        "{}"
      );

    const report = reportUpcoming(db, 800, 0.1);
    expect(report.rows.length).toBeGreaterThan(64);
  });

  test("skips stale forecast candidates with old last-seen activity", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const staleLast = new Date(today);
    staleLast.setUTCDate(staleLast.getUTCDate() - 200);
    const staleNext = new Date(staleLast);
    staleNext.setUTCDate(staleNext.getUTCDate() + 30);

    const activeLast = new Date(today);
    activeLast.setUTCDate(activeLast.getUTCDate() - 20);
    const activeNext = new Date(activeLast);
    activeNext.setUTCDate(activeNext.getUTCDate() + 30);

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
      999,
      "USD",
      12,
      "2024-01-01",
      staleLast.toISOString().slice(0, 10),
      staleNext.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );
    insert.run(
      "active-monthly",
      "Active Monthly",
      "monthly",
      1299,
      "USD",
      12,
      "2025-01-01",
      activeLast.toISOString().slice(0, 10),
      activeNext.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );

    const report = reportUpcoming(db, 60, 0.1);
    const merchants = new Set(report.rows.map((row) => row.merchantKey));
    expect(merchants.has("stale-monthly")).toBe(false);
    expect(merchants.has("active-monthly")).toBe(true);
  });

  test("excludes monthly candidates with no charge in over 8 weeks even if next date is upcoming", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const staleLast = new Date(today);
    staleLast.setUTCDate(staleLast.getUTCDate() - 70);
    const upcomingNext = new Date(today);
    upcomingNext.setUTCDate(upcomingNext.getUTCDate() + 3);

    db.db
      .query(
        `INSERT INTO recurring_candidate (
          merchant_key, merchant_display, cadence, typical_amount_minor,
          currency, occurrences_count, first_seen_date, last_seen_date,
          predicted_next_date, confidence, is_usage_based, reason_codes,
          source_evidence_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        "monthly-inactive",
        "Monthly Inactive",
        "monthly",
        1299,
        "USD",
        12,
        "2024-01-01",
        staleLast.toISOString().slice(0, 10),
        upcomingNext.toISOString().slice(0, 10),
        0.9,
        0,
        "[]",
        "{}"
      );

    const report = reportUpcoming(db, 10, 0.1);
    expect(report.rows.some((row) => row.merchantKey === "monthly-inactive")).toBe(false);
  });

  test("excludes non-monthly candidates after two missed billing cycles", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const staleQuarterlyLast = new Date(today);
    staleQuarterlyLast.setUTCDate(staleQuarterlyLast.getUTCDate() - 190);
    const staleQuarterlyNext = new Date(today);
    staleQuarterlyNext.setUTCDate(staleQuarterlyNext.getUTCDate() + 10);

    const freshQuarterlyLast = new Date(today);
    freshQuarterlyLast.setUTCDate(freshQuarterlyLast.getUTCDate() - 120);
    const freshQuarterlyNext = new Date(today);
    freshQuarterlyNext.setUTCDate(freshQuarterlyNext.getUTCDate() + 10);

    const insert = db.db.query(
      `INSERT INTO recurring_candidate (
        merchant_key, merchant_display, cadence, typical_amount_minor,
        currency, occurrences_count, first_seen_date, last_seen_date,
        predicted_next_date, confidence, is_usage_based, reason_codes,
        source_evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    insert.run(
      "quarterly-stale",
      "Quarterly Stale",
      "quarterly",
      5000,
      "USD",
      6,
      "2024-01-01",
      staleQuarterlyLast.toISOString().slice(0, 10),
      staleQuarterlyNext.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );
    insert.run(
      "quarterly-fresh",
      "Quarterly Fresh",
      "quarterly",
      5000,
      "USD",
      6,
      "2024-01-01",
      freshQuarterlyLast.toISOString().slice(0, 10),
      freshQuarterlyNext.toISOString().slice(0, 10),
      0.9,
      0,
      "[]",
      "{}"
    );

    const report = reportUpcoming(db, 20, 0.1);
    const keys = new Set(report.rows.map((row) => row.merchantKey));
    expect(keys.has("quarterly-stale")).toBe(false);
    expect(keys.has("quarterly-fresh")).toBe(true);
  });
});
