import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { recomputeMatches } from "../src/derive/matching";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("recomputeMatches", () => {
  test("uses deterministic lexical tie-break when score/date/similarity match", async () => {
    handle = await createTestDb();
    const { db } = handle;

    db.db
      .query(
        `INSERT INTO normalized_transaction (
          ynab_transaction_id, budget_id, txn_date,
          merchant_raw, merchant_canonical, merchant_key,
          amount_minor, currency, account_name, category_name,
          include_in_spend, eligibility_status, eligibility_reasons,
          is_outflow, is_usage_based, source_updated_at, normalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        "txn_1",
        "budget_1",
        "2026-02-10",
        "Spotify",
        "Spotify",
        "spotify",
        1099,
        "USD",
        "Checking",
        "Entertainment",
        1,
        "eligible",
        "[]",
        1,
        0
      );

    for (const id of ["b", "a"]) {
      db.db
        .query(
          `INSERT INTO normalized_email_purchase (
            canonical_email_evidence_id, datetime, merchant_key, item_name_norm,
            item_price_minor, currency, amount_evidence_type, parse_confidence,
            parser_version, normalized_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(id, "2026-02-10T16:00:00.000Z", "spotify", "spotify premium", 1099, "USD", "order_total", 0.9, "v1");
    }

    const result = recomputeMatches(db);
    expect(result.transactionsConsidered).toBe(1);
    expect(result.candidatePairs).toBe(2);

    const winner = db.db
      .query(
        `SELECT canonical_email_evidence_id
         FROM transaction_email_match
         WHERE ynab_transaction_id = 'txn_1' AND is_winner = 1`
      )
      .get() as { canonical_email_evidence_id: string } | undefined;

    expect(winner?.canonical_email_evidence_id).toBe("a");
  });
});
