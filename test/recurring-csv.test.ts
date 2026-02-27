import { describe, expect, test } from "bun:test";
import { filterActiveCandidates, mergeLikelyDuplicateCandidates, type CandidateRow } from "../src/tools/export-recurring-csv";

describe("recurring csv dedupe", () => {
  test("merges insurance rename chains and preserves full payment timeline", () => {
    const rows: CandidateRow[] = [
      {
        merchant_display: "GOLDENRULE INS PREM095805584Travis Hinton",
        cadence: "monthly",
        typical_amount_minor: 4311,
        first_seen_date: "2024-01-26",
        last_seen_date: "2025-02-26",
        predicted_next_date: "2025-03-26",
        confidence: 0.71,
      },
      {
        merchant_display: "UnitedHealthOne",
        cadence: "monthly",
        typical_amount_minor: 4328,
        first_seen_date: "2025-03-26",
        last_seen_date: "2025-07-28",
        predicted_next_date: "2025-08-28",
        confidence: 0.72,
      },
      {
        merchant_display: "United Healthcare",
        cadence: "monthly",
        typical_amount_minor: 4328,
        first_seen_date: "2025-08-26",
        last_seen_date: "2025-10-28",
        predicted_next_date: "2025-11-28",
        confidence: 0.74,
      },
    ];

    const merged = mergeLikelyDuplicateCandidates(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].first_seen_date).toBe("2024-01-26");
    expect(merged[0].last_seen_date).toBe("2025-10-28");
    expect(merged[0].source_merchant_names).toEqual([
      "GOLDENRULE INS PREM095805584Travis Hinton",
      "United Healthcare",
      "UnitedHealthOne",
    ]);
  });

  test("does not merge unrelated subscriptions with same cadence and amount", () => {
    const rows: CandidateRow[] = [
      {
        merchant_display: "Netflix",
        cadence: "monthly",
        typical_amount_minor: 1599,
        first_seen_date: "2025-01-08",
        last_seen_date: "2026-02-08",
        predicted_next_date: "2026-03-08",
        confidence: 0.8,
      },
      {
        merchant_display: "Spotify",
        cadence: "monthly",
        typical_amount_minor: 1599,
        first_seen_date: "2025-01-10",
        last_seen_date: "2026-02-10",
        predicted_next_date: "2026-03-10",
        confidence: 0.8,
      },
    ];

    const merged = mergeLikelyDuplicateCandidates(rows);
    expect(merged).toHaveLength(2);
  });

  test("does not merge concurrent same-merchant streams with different billing days", () => {
    const rows: CandidateRow[] = [
      {
        merchant_display: "OpenAI [~8]",
        cadence: "monthly",
        typical_amount_minor: 20000,
        first_seen_date: "2025-12-08",
        last_seen_date: "2026-02-08",
        predicted_next_date: "2026-03-08",
        confidence: 0.7,
      },
      {
        merchant_display: "OpenAI [~13]",
        cadence: "monthly",
        typical_amount_minor: 20000,
        first_seen_date: "2025-12-13",
        last_seen_date: "2026-02-13",
        predicted_next_date: "2026-03-13",
        confidence: 0.68,
      },
    ];

    const merged = mergeLikelyDuplicateCandidates(rows);
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((row) => row.predicted_next_date))).toEqual(
      new Set(["2026-03-08", "2026-03-13"])
    );
  });

  test("filters inactive rows after two missed cadence cycles", () => {
    const merged = mergeLikelyDuplicateCandidates([
      {
        merchant_display: "Monthly Fresh",
        cadence: "monthly",
        typical_amount_minor: 1000,
        first_seen_date: "2025-01-01",
        last_seen_date: "2026-01-29",
        predicted_next_date: "2026-02-28",
        confidence: 0.8,
      },
      {
        merchant_display: "Monthly Stale",
        cadence: "monthly",
        typical_amount_minor: 1000,
        first_seen_date: "2025-01-01",
        last_seen_date: "2025-10-01",
        predicted_next_date: "2025-11-01",
        confidence: 0.8,
      },
    ]);

    const active = filterActiveCandidates(merged, "2026-02-27");
    expect(active.map((row) => row.merchant_display).sort()).toEqual(["Monthly Fresh"]);
  });
});
