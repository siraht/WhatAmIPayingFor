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
        "2026-01-01",
        nextDate,
        0.9,
        0,
        "[]",
        "{}"
      );

    const report = reportUpcoming(db, 800, 0.1);
    expect(report.rows.length).toBeGreaterThan(64);
  });
});
