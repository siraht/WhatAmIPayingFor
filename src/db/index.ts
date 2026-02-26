import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ensureParentDir } from "../utils/paths";
import { MIGRATIONS } from "./migrations";

export class FintrackDb {
  readonly db: Database;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  close(): void {
    this.db.close();
  }
}

export const openDatabase = async (dbPath: string): Promise<FintrackDb> => {
  await ensureParentDir(dbPath);
  const db = new FintrackDb(dbPath);
  applyMigrations(db);
  return db;
};

export const applyMigrations = (conn: FintrackDb): void => {
  conn.db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

  const row = conn.db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version").get() as
    | { version: number }
    | undefined;

  const current = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }

    const tx = conn.db.transaction(() => {
      conn.db.exec(migration.sql);
      conn.db
        .query("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))")
        .run(migration.version);
    });

    tx();
  }
};

export const databaseExists = (dbPath: string): boolean => existsSync(dbPath);
