import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type FintrackDb } from "../src/db";

export interface TestDbHandle {
  dir: string;
  db: FintrackDb;
  cleanup: () => void;
}

export const createTestDb = async (): Promise<TestDbHandle> => {
  const dir = mkdtempSync(join(tmpdir(), "fintrack-test-"));
  const dbPath = join(dir, "test.db");
  const db = await openDatabase(dbPath);

  return {
    dir,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
