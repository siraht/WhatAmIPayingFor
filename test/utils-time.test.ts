import { describe, expect, test } from "bun:test";
import { monthsAgoIsoDate } from "../src/utils/time";

describe("monthsAgoIsoDate", () => {
  test("subtracts full calendar months and preserves day when possible", () => {
    const now = new Date(Date.UTC(2026, 1, 27, 12, 30, 0));
    expect(monthsAgoIsoDate(6, now)).toBe("2025-08-27");
  });

  test("clamps to month end when target month has fewer days", () => {
    const now = new Date(Date.UTC(2026, 2, 31, 8, 0, 0));
    expect(monthsAgoIsoDate(1, now)).toBe("2026-02-28");
  });

  test("rejects negative month offsets", () => {
    expect(() => monthsAgoIsoDate(-1)).toThrow("Invalid months offset");
  });
});
