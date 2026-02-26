import { AppError, isAppError } from "../errors";
import { EXIT } from "../constants";
import type { RuntimeContext } from "../runtime";
import { YnabClient, syncYnab } from "../ingest/ynab";
import { syncEmail } from "../ingest/email";
import { loadRulesFile } from "../config";
import { recomputeDerivedLayers } from "../pipeline";
import { confirm } from "../utils/prompt";
import { requireIntegerInRange, requireIsoDate } from "../utils/validate";

export interface SyncYnabCommandOptions {
  since?: string;
  dryRun?: boolean;
  resetCursor?: boolean;
  force?: boolean;
}

export interface SyncEmailCommandOptions {
  days?: number;
  deepParse?: boolean;
  dryRun?: boolean;
  resetCursor?: boolean;
  force?: boolean;
}

const ensureResetSafety = async (
  ctx: RuntimeContext,
  resetCursor: boolean | undefined,
  force: boolean | undefined,
  sourceName: string
): Promise<void> => {
  if (!resetCursor) {
    return;
  }
  if (force) {
    return;
  }
  if (ctx.flags.noInput || !process.stdout.isTTY) {
    throw new AppError(`${sourceName} cursor reset requires --force in non-interactive mode`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "CURSOR_RESET_FORCE_REQUIRED",
    });
  }

  const accepted = await confirm(`Reset ${sourceName} sync cursor and re-bootstrap from source?`);
  if (!accepted) {
    throw new AppError(`${sourceName} cursor reset canceled`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "CURSOR_RESET_CANCELLED",
    });
  }
};

export const runSyncYnab = async (
  ctx: RuntimeContext,
  options: SyncYnabCommandOptions
): Promise<unknown> => {
  const since = options.since ? requireIsoDate("--since", options.since) : undefined;

  if (!ctx.config.ynab) {
    throw new AppError("YNAB is not configured. Run `fintrack setup ynab` first.", {
      exitCode: EXIT.INVALID_ARGS,
      code: "YNAB_NOT_CONFIGURED",
    });
  }
  await ensureResetSafety(ctx, options.resetCursor, options.force, "YNAB");

  const token = process.env[ctx.config.ynab.tokenEnv];
  if (!token) {
    throw new AppError(
      `Missing YNAB token in environment variable ${ctx.config.ynab.tokenEnv}`,
      {
        exitCode: EXIT.AUTH_FAILURE,
        code: "YNAB_TOKEN_MISSING",
      }
    );
  }

  const client = new YnabClient(token, ctx.logger);
  const db = ctx.db;
  if (!db) {
    throw new AppError("Database unavailable for sync", { code: "DB_NOT_AVAILABLE" });
  }

  const result = await syncYnab(db, client, {
    budgetId: ctx.config.ynab.budgetId,
    since,
    dryRun: options.dryRun,
    resetCursor: options.resetCursor,
    logger: ctx.logger,
  });

  return {
    action: "sync.ynab",
    dryRun: !!options.dryRun,
    ...result,
  };
};

export const runSyncEmail = async (
  ctx: RuntimeContext,
  options: SyncEmailCommandOptions
): Promise<unknown> => {
  const days = requireIntegerInRange("--days", options.days ?? 365, { min: 1, max: 36500 });

  if (!ctx.config.email) {
    throw new AppError("Email is not configured. Run `fintrack setup email` first.", {
      exitCode: EXIT.INVALID_ARGS,
      code: "EMAIL_NOT_CONFIGURED",
    });
  }
  await ensureResetSafety(ctx, options.resetCursor, options.force, "email");

  const db = ctx.db;
  if (!db) {
    throw new AppError("Database unavailable for sync", { code: "DB_NOT_AVAILABLE" });
  }

  const result = await syncEmail(
    db,
    {
      host: ctx.config.email.imapHost,
      port: ctx.config.email.imapPort,
      user: ctx.config.email.imapUser,
      passCmd: ctx.config.email.imapPassCmd,
      folders: ctx.config.email.folders,
      accountLabel: ctx.config.email.accountLabel,
    },
    {
      days,
      deepParse: options.deepParse,
      dryRun: options.dryRun,
      parserVersion: ctx.config.parserVersion,
      resetCursor: options.resetCursor,
      logger: ctx.logger,
    }
  );

  return {
    action: "sync.email",
    dryRun: !!options.dryRun,
    ...result,
  };
};

export interface SyncAllOptions extends SyncYnabCommandOptions, SyncEmailCommandOptions {
  days?: number;
  deepParse?: boolean;
}

export const runSyncAll = async (ctx: RuntimeContext, options: SyncAllOptions): Promise<{
  exitCode: number;
  data: unknown;
}> => {
  const warnings: Array<{ stage: string; error: string; code?: string }> = [];
  const data: Record<string, unknown> = {
    action: "sync.all",
  };

  let successfulStages = 0;

  try {
    data.ynab = await runSyncYnab(ctx, options);
    successfulStages += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      stage: "sync.ynab",
      error: message,
      code: isAppError(error) ? error.code : undefined,
    });
  }

  try {
    data.email = await runSyncEmail(ctx, options);
    successfulStages += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      stage: "sync.email",
      error: message,
      code: isAppError(error) ? error.code : undefined,
    });
  }

  if (successfulStages > 0 && !options.dryRun && ctx.db) {
    const rules = await loadRulesFile(ctx.paths);
    data.derived = recomputeDerivedLayers(ctx.db, ctx.config, rules);
  }

  if (warnings.length > 0) {
    data.warnings = warnings;
    if (successfulStages === 0) {
      throw new AppError("All sync stages failed", {
        exitCode: EXIT.RUNTIME,
        code: "SYNC_ALL_FAILED",
        details: warnings,
      });
    }
    return {
      exitCode: EXIT.PARTIAL_SUCCESS,
      data,
    };
  }

  return {
    exitCode: EXIT.SUCCESS,
    data,
  };
};
