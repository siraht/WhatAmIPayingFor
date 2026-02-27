import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { normalizeTransactions } from "../src/normalize/transactions";

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

describe("normalizeTransactions", () => {
  test("excludes subtransaction children from spend totals", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO raw_ynab_transaction (
        ynab_transaction_id, budget_id, account_id, account_name, date,
        amount_milliunits, payee_name, memo, cleared, approved, deleted,
        transfer_account_id, transfer_transaction_id, parent_transaction_id,
        category_name, category_id, debt_transaction_type, import_id, flag_color,
        raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    insert.run(
      "txn_parent",
      "budget_1",
      "acct_1",
      "Checking",
      "2026-02-10",
      -15000,
      "Store",
      null,
      "cleared",
      1,
      0,
      null,
      null,
      null,
      "Groceries",
      "cat_1",
      null,
      null,
      null,
      JSON.stringify({ subtransactions: [{ id: "sub_1" }] })
    );

    insert.run(
      "txn_child",
      "budget_1",
      "acct_1",
      "Checking",
      "2026-02-10",
      -5000,
      "Store",
      null,
      "cleared",
      1,
      0,
      null,
      null,
      "txn_parent",
      "Groceries",
      "cat_1",
      null,
      null,
      null,
      JSON.stringify({})
    );

    const result = normalizeTransactions(db, "USD", emptyRules);
    expect(result.processed).toBe(2);
    expect(result.eligible).toBe(1);
    expect(result.excluded).toBe(1);

    const child = db.db
      .query(
        `SELECT include_in_spend, eligibility_reasons
         FROM normalized_transaction
         WHERE ynab_transaction_id = 'txn_child'`
      )
      .get() as { include_in_spend: number; eligibility_reasons: string };

    expect(child.include_in_spend).toBe(0);
    expect((JSON.parse(child.eligibility_reasons) as string[]).includes("R_SUBTRANSACTION_CHILD")).toBe(true);
  });

  test("excludes transfer-like payees when transfer ids are missing", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const insert = db.db.query(
      `INSERT INTO raw_ynab_transaction (
        ynab_transaction_id, budget_id, account_id, account_name, date,
        amount_milliunits, payee_name, memo, cleared, approved, deleted,
        transfer_account_id, transfer_transaction_id, parent_transaction_id,
        category_name, category_id, debt_transaction_type, import_id, flag_color,
        raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    insert.run(
      "txn_xfr",
      "budget_1",
      "acct_1",
      "Checking",
      "2025-12-29",
      -400000,
      "XFR XFER TO DDA 12345",
      null,
      "cleared",
      1,
      0,
      null,
      null,
      null,
      "Uncategorized",
      null,
      null,
      null,
      null,
      JSON.stringify({})
    );

    insert.run(
      "txn_grocery",
      "budget_1",
      "acct_1",
      "Checking",
      "2025-12-29",
      -15000,
      "Whole Foods",
      null,
      "cleared",
      1,
      0,
      null,
      null,
      null,
      "Groceries",
      "cat_1",
      null,
      null,
      null,
      JSON.stringify({})
    );

    const result = normalizeTransactions(db, "USD", emptyRules);
    expect(result.processed).toBe(2);
    expect(result.eligible).toBe(1);
    expect(result.excluded).toBe(1);

    const xfr = db.db
      .query(
        `SELECT include_in_spend, eligibility_reasons
         FROM normalized_transaction
         WHERE ynab_transaction_id = 'txn_xfr'`
      )
      .get() as { include_in_spend: number; eligibility_reasons: string };

    expect(xfr.include_in_spend).toBe(0);
    expect((JSON.parse(xfr.eligibility_reasons) as string[]).includes("R_TRANSFER_LIKE_PAYEE")).toBe(
      true
    );
  });
});
