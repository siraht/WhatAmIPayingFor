import type { FintrackDb } from "./index";
import type { SyncCursor } from "../types";

export const getSyncCursor = (db: FintrackDb, source: string, scope: string): SyncCursor | null => {
  const row = db.db
    .query("SELECT cursor_json FROM sync_state WHERE source = ? AND scope = ?")
    .get(source, scope) as { cursor_json?: string } | undefined;

  if (!row?.cursor_json) {
    return null;
  }

  return JSON.parse(row.cursor_json) as SyncCursor;
};

export const setSyncCursor = (db: FintrackDb, source: string, scope: string, cursor: SyncCursor): void => {
  db.db
    .query(
      `INSERT INTO sync_state (source, scope, cursor_json, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(source, scope)
       DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`
    )
    .run(source, scope, JSON.stringify(cursor));
};
