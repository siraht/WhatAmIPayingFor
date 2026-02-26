import { AppError } from "../errors";
import type { RuntimeContext } from "../runtime";
import { loadRulesFile } from "../config";
import { recomputeDerivedLayers } from "../pipeline";
import { reportSpend, type SpendGroupBy } from "../report/spend";
import { reportSubscriptions } from "../report/subscriptions";
import { renderUpcomingVisual, reportUpcoming } from "../report/upcoming";

const defaultMonth = (): string => new Date().toISOString().slice(0, 7);

const validateConfidence = (value: number): void => {
  if (value < 0 || value > 1) {
    throw new AppError("--min-confidence must be between 0 and 1", {
      code: "INVALID_CONFIDENCE",
    });
  }
};

const recompute = async (ctx: RuntimeContext): Promise<unknown> => {
  if (!ctx.db) {
    throw new AppError("Database unavailable for report", {
      code: "DB_NOT_AVAILABLE",
    });
  }
  const rules = await loadRulesFile(ctx.paths);
  return recomputeDerivedLayers(ctx.db, ctx.config, rules);
};

export interface ReportSpendOptions {
  month?: string;
  groupBy?: SpendGroupBy;
}

export const runReportSpend = async (ctx: RuntimeContext, options: ReportSpendOptions): Promise<unknown> => {
  await recompute(ctx);
  const month = options.month || defaultMonth();
  const groupBy = options.groupBy || "merchant";

  if (!ctx.db) {
    throw new AppError("Database unavailable for report", { code: "DB_NOT_AVAILABLE" });
  }

  const report = reportSpend(ctx.db, month, groupBy);
  return {
    action: "report.spend",
    ...report,
  };
};

export interface ReportSubscriptionsOptions {
  month?: string;
  minConfidence?: number;
  includeUsageBased?: boolean;
  explain?: boolean;
}

export const runReportSubscriptions = async (
  ctx: RuntimeContext,
  options: ReportSubscriptionsOptions
): Promise<unknown> => {
  await recompute(ctx);
  const month = options.month || defaultMonth();
  const minConfidence = options.minConfidence ?? 0.65;
  validateConfidence(minConfidence);

  if (!ctx.db) {
    throw new AppError("Database unavailable for report", { code: "DB_NOT_AVAILABLE" });
  }

  const report = reportSubscriptions(ctx.db, {
    month,
    minConfidence,
    includeUsageBased: !!options.includeUsageBased,
  });

  if (!options.explain) {
    const rows = report.rows.map((row) => ({ ...row, reasonCodes: [] }));
    return {
      action: "report.subscriptions",
      month,
      minConfidence,
      rows,
    };
  }

  return {
    action: "report.subscriptions",
    ...report,
  };
};

export interface ReportUpcomingOptions {
  days?: number;
  minConfidence?: number;
  visual?: boolean;
}

export const runReportUpcoming = async (ctx: RuntimeContext, options: ReportUpcomingOptions): Promise<unknown> => {
  await recompute(ctx);
  const days = options.days ?? 30;
  const minConfidence = options.minConfidence ?? 0.65;
  validateConfidence(minConfidence);

  if (!ctx.db) {
    throw new AppError("Database unavailable for report", { code: "DB_NOT_AVAILABLE" });
  }

  const report = reportUpcoming(ctx.db, days, minConfidence);
  const visual = options.visual ? renderUpcomingVisual(report) : null;

  return {
    action: "report.upcoming",
    ...report,
    visual,
  };
};
