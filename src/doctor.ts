import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { FintrackDb } from "./db";
import type { FintrackConfig, RuntimePaths } from "./types";
import { EXIT } from "./constants";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
  detail?: unknown;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: {
    ok: number;
    failed: number;
    warnings: number;
  };
  exitCode: number;
}

export const runDoctor = (
  paths: RuntimePaths,
  config: FintrackConfig,
  db: FintrackDb | null
): DoctorReport => {
  const checks: DoctorCheck[] = [];

  checks.push({
    id: "config.exists",
    ok: existsSync(paths.configPath),
    message: existsSync(paths.configPath) ? "Config file present" : "Config file missing",
    detail: { configPath: paths.configPath },
  });

  checks.push({
    id: "rules.exists",
    ok: existsSync(paths.rulesPath),
    message: existsSync(paths.rulesPath) ? "Rules file present" : "Rules file missing",
    detail: { rulesPath: paths.rulesPath },
  });

  checks.push({
    id: "db.exists",
    ok: existsSync(paths.dbPath),
    message: existsSync(paths.dbPath) ? "SQLite database present" : "SQLite database missing",
    detail: { dbPath: paths.dbPath },
  });

  if (db) {
    try {
      const row = db.db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version").get() as
        | { version: number }
        | undefined;
      checks.push({
        id: "db.schema_version",
        ok: (row?.version ?? 0) > 0,
        message: `Schema version ${row?.version ?? 0}`,
        detail: row,
      });
    } catch (error) {
      checks.push({
        id: "db.schema_version",
        ok: false,
        message: "Unable to read schema version",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const syncRows = db.db
        .query("SELECT source, scope, updated_at FROM sync_state ORDER BY updated_at DESC LIMIT 10")
        .all() as Array<{ source: string; scope: string; updated_at: string }>;
      checks.push({
        id: "sync_state.present",
        ok: syncRows.length > 0,
        message: syncRows.length > 0 ? "Sync state available" : "No sync state yet",
        detail: syncRows,
      });
    } catch (error) {
      checks.push({
        id: "sync_state.present",
        ok: false,
        message: "Unable to read sync state table",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.ynab) {
    const token = process.env[config.ynab.tokenEnv];
    checks.push({
      id: "ynab.token_env",
      ok: !!token,
      message: token
        ? `YNAB token env ${config.ynab.tokenEnv} is set`
        : `YNAB token env ${config.ynab.tokenEnv} is missing`,
    });
    checks.push({
      id: "ynab.budget_id",
      ok: !!config.ynab.budgetId,
      message: config.ynab.budgetId ? "YNAB budget id configured" : "YNAB budget id missing",
      detail: { budgetId: config.ynab.budgetId, selector: config.ynab.budgetSelector },
    });
  } else {
    checks.push({
      id: "ynab.config",
      ok: false,
      message: "YNAB is not configured yet",
    });
  }

  if (config.email) {
    checks.push({
      id: "email.config",
      ok: true,
      message: "Email IMAP config present",
      detail: {
        host: config.email.imapHost,
        port: config.email.imapPort,
        user: config.email.imapUser,
        folders: config.email.folders,
      },
    });

    const probe = spawnSync("bash", ["-lc", config.email.imapPassCmd], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    checks.push({
      id: "email.pass_cmd",
      ok: probe.status === 0 && probe.stdout.trim().length > 0,
      message:
        probe.status === 0 && probe.stdout.trim().length > 0
          ? "IMAP password command works"
          : "IMAP password command failed or empty",
      detail: {
        status: probe.status,
      },
    });
  } else {
    checks.push({
      id: "email.config",
      ok: false,
      message: "Email is not configured yet",
    });
  }

  const failed = checks.filter((check) => !check.ok).length;
  const ok = checks.length - failed;

  const exitCode = failed === 0 ? EXIT.SUCCESS : EXIT.PARTIAL_SUCCESS;

  return {
    checks,
    summary: {
      ok,
      failed,
      warnings: failed,
    },
    exitCode,
  };
};
