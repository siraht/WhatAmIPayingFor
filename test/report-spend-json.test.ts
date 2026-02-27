import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type FintrackDb } from "../src/db";

interface StateHandle {
  dir: string;
  db: FintrackDb;
}

let handle: StateHandle | null = null;

afterEach(() => {
  if (!handle) {
    return;
  }
  handle.db.close();
  rmSync(handle.dir, { recursive: true, force: true });
  handle = null;
});

describe("report spend json", () => {
  test("includes major/display totals to avoid minor-unit confusion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fintrack-spend-json-"));
    const db = await openDatabase(join(dir, "fintrack.db"));
    handle = { dir, db };

    db.db
      .query(
        `INSERT INTO raw_ynab_transaction (
          ynab_transaction_id, budget_id, account_id, account_name, date,
          amount_milliunits, payee_name, memo, cleared, approved, deleted,
          transfer_account_id, transfer_transaction_id, parent_transaction_id,
          category_name, category_id, debt_transaction_type, import_id, flag_color,
          raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        "txn_1",
        "budget_1",
        "acct_1",
        "Checking",
        "2026-02-10",
        -12345,
        "Coffee Shop",
        null,
        "cleared",
        1,
        0,
        null,
        null,
        null,
        "Dining Out",
        "cat_1",
        null,
        null,
        null,
        JSON.stringify({})
      );

    const proc = Bun.spawnSync(
      ["bun", "run", "src/cli.ts", "report", "spend", "--month", "2026-02", "--json", "--state-dir", dir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.action).toBe("report.spend");
    expect(payload.totalMinor).toBe(1235);
    expect(payload.totalMajor).toBe(12.35);
    expect(payload.totalUsd).toBe(12.35);
    expect(payload.totalDisplay).toBe("$12.35");
    expect(payload.rows[0].totalMajor).toBe(12.35);
    expect(payload.rows[0].totalUsd).toBe(12.35);
    expect(payload.rows[0].totalDisplay).toBe("$12.35");
  });
});
