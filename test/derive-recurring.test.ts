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
});
