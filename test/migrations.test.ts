import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { openDatabase } from "../src/db";
import { join } from "node:path";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("migrations", () => {
  test("applies initial schema once and stays forward-only on reopen", async () => {
    handle = await createTestDb();
    const dbPath = join(handle.dir, "test.db");

    const version1 = handle.db.db
      .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version")
      .get() as { version: number };
    expect(version1.version).toBe(1);

    handle.db.close();

    const reopened = await openDatabase(dbPath);
    const version2 = reopened.db
      .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version")
      .get() as { version: number };
    expect(version2.version).toBe(1);

    reopened.close();
  });
});
