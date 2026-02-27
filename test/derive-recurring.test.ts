import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { recomputeRecurring } from "../src/derive/recurring";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const emptyRules = {
  aliasByRawKey: new Map<string, string>(),
  ignore: new Set<string>(),
  force: new Set<string>(),
};

describe("recomputeRecurring", () => {
  test("detects monthly cadence and clamps short-month prediction", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO normalized_transaction (
        ynab_transaction_id, budget_id, txn_date,
        merchant_raw, merchant_canonical, merchant_key,
        amount_minor, currency, account_name, category_name,
        include_in_spend, eligibility_status, eligibility_reasons,
        is_outflow, is_usage_based, source_updated_at, normalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );

    insert.run(
      "txn_1",
      "budget_1",
      "2025-11-30",
      "Netflix",
      "Netflix",
      "netflix",
      1599,
      "USD",
      "Checking",
      "Subscriptions",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "txn_2",
      "budget_1",
      "2025-12-31",
      "Netflix",
      "Netflix",
      "netflix",
      1599,
      "USD",
      "Checking",
      "Subscriptions",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "txn_3",
      "budget_1",
      "2026-01-31",
      "Netflix",
      "Netflix",
      "netflix",
      1599,
      "USD",
      "Checking",
      "Subscriptions",
      1,
      "eligible",
      "[]",
      1,
      0
    );

    const result = recomputeRecurring(db, emptyRules);
    expect(result.candidates).toBe(1);

    const row = db.db
      .query(
        `SELECT cadence, predicted_next_date
         FROM recurring_candidate
         WHERE merchant_key = 'netflix'`
      )
      .get() as { cadence: string; predicted_next_date: string } | undefined;

    expect(row?.cadence).toBe("monthly");
    expect(row?.predicted_next_date).toBe("2026-02-28");
  });

  test("excludes grocery and fuel-food merchants from recurring candidates", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO normalized_transaction (
        ynab_transaction_id, budget_id, txn_date,
        merchant_raw, merchant_canonical, merchant_key,
        amount_minor, currency, account_name, category_name,
        include_in_spend, eligibility_status, eligibility_reasons,
        is_outflow, is_usage_based, source_updated_at, normalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );

    insert.run(
      "wf_1",
      "budget_1",
      "2025-11-01",
      "Whole Foods",
      "Whole Foods",
      "whole foods",
      3200,
      "USD",
      "Checking",
      "Groceries",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "wf_2",
      "budget_1",
      "2025-11-08",
      "Whole Foods",
      "Whole Foods",
      "whole foods",
      3150,
      "USD",
      "Checking",
      "Groceries",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "wf_3",
      "budget_1",
      "2025-11-15",
      "Whole Foods",
      "Whole Foods",
      "whole foods",
      3300,
      "USD",
      "Checking",
      "Groceries",
      1,
      "eligible",
      "[]",
      1,
      0
    );

    const result = recomputeRecurring(db, emptyRules);
    expect(result.candidates).toBe(0);

    const rows = db.db
      .query("SELECT merchant_key FROM recurring_candidate")
      .all() as Array<{ merchant_key: string }>;
    expect(rows.length).toBe(0);
  });

  test("keeps long-running monthly subscriptions using recent cadence window", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO normalized_transaction (
        ynab_transaction_id, budget_id, txn_date,
        merchant_raw, merchant_canonical, merchant_key,
        amount_minor, currency, account_name, category_name,
        include_in_spend, eligibility_status, eligibility_reasons,
        is_outflow, is_usage_based, source_updated_at, normalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );

    const months = [
      "2025-01-03",
      "2025-02-03",
      "2025-03-03",
      "2025-04-03",
      "2025-05-03",
      "2025-06-03",
      "2025-07-03",
      "2025-08-03",
      "2025-09-03",
      "2025-10-03",
      "2025-11-03",
      "2025-12-03",
    ];

    for (let i = 0; i < months.length; i += 1) {
      insert.run(
        `warp_${i + 1}`,
        "budget_1",
        months[i],
        "Warp.dev",
        "Warp.dev",
        "warp dev",
        1869,
        "USD",
        "Checking",
        "AI",
        1,
        "eligible",
        "[]",
        1,
        1
      );
    }

    const result = recomputeRecurring(db, emptyRules);
    expect(result.candidates).toBe(1);

    const row = db.db
      .query(
        `SELECT merchant_key, cadence, confidence
         FROM recurring_candidate
         WHERE merchant_key = 'warp dev'`
      )
      .get() as { merchant_key: string; cadence: string; confidence: number } | undefined;

    expect(row?.merchant_key).toBe("warp dev");
    expect(row?.cadence).toBe("monthly");
    expect((row?.confidence ?? 0) > 0.3).toBe(true);
  });

  test("excludes food/fuel cadence using category signals even without merchant keyword", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO normalized_transaction (
        ynab_transaction_id, budget_id, txn_date,
        merchant_raw, merchant_canonical, merchant_key,
        amount_minor, currency, account_name, category_name,
        include_in_spend, eligibility_status, eligibility_reasons,
        is_outflow, is_usage_based, source_updated_at, normalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );

    insert.run(
      "food_1",
      "budget_1",
      "2025-11-05",
      "Bluebonnet Cafe",
      "Bluebonnet Cafe",
      "bluebonnet cafe",
      1800,
      "USD",
      "Checking",
      "Dining Out",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "food_2",
      "budget_1",
      "2025-11-12",
      "Bluebonnet Cafe",
      "Bluebonnet Cafe",
      "bluebonnet cafe",
      2100,
      "USD",
      "Checking",
      "Dining Out",
      1,
      "eligible",
      "[]",
      1,
      0
    );
    insert.run(
      "food_3",
      "budget_1",
      "2025-11-19",
      "Bluebonnet Cafe",
      "Bluebonnet Cafe",
      "bluebonnet cafe",
      1950,
      "USD",
      "Checking",
      "Dining Out",
      1,
      "eligible",
      "[]",
      1,
      0
    );

    const result = recomputeRecurring(db, emptyRules);
    expect(result.candidates).toBe(0);
  });
});
