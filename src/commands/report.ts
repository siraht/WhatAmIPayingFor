import { AppError } from "../errors";
import { EXIT } from "../constants";
import type { RuntimeContext } from "../runtime";
import { loadRulesFile } from "../config";
import { recomputeDerivedLayers } from "../pipeline";
import { reportSpend, type SpendGroupBy } from "../report/spend";
import { reportSubscriptions } from "../report/subscriptions";
import { renderUpcomingVisual, reportUpcoming } from "../report/upcoming";
import { requireIntegerInRange, requireOneOf, requireYearMonth } from "../utils/validate";
import { minorToDisplay } from "../utils/money";

const defaultMonth = (): string => new Date().toISOString().slice(0, 7);
const minorToMajor = (minor: number): number => Number((minor / 100).toFixed(2));

const validateConfidence = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AppError("--min-confidence must be between 0 and 1", {
      exitCode: EXIT.INVALID_ARGS,
      code: "INVALID_CONFIDENCE",
      details: { value: Number.isNaN(value) ? "NaN" : value },
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
  const month = requireYearMonth("--month", options.month || defaultMonth());
  const groupBy = requireOneOf("--group-by", options.groupBy || "merchant", [
    "merchant",
    "category",
    "account",
  ]);

  if (!ctx.db) {
    throw new AppError("Database unavailable for report", { code: "DB_NOT_AVAILABLE" });
  }

  const report = reportSpend(ctx.db, month, groupBy);
  const rows = report.rows.map((row) => {
    const totalMajor = minorToMajor(row.total_minor);
    return {
      ...row,
      totalMajor,
      totalUsd: totalMajor,
      totalDisplay: minorToDisplay(row.total_minor, ctx.config.currency),
    };
  });
  const totalMajor = minorToMajor(report.totalMinor);

  return {
    action: "report.spend",
    currency: ctx.config.currency,
    ...report,
    rows,
    totalMajor,
    totalUsd: totalMajor,
    totalDisplay: minorToDisplay(report.totalMinor, ctx.config.currency),
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
  const month = requireYearMonth("--month", options.month || defaultMonth());
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
  const days = requireIntegerInRange("--days", options.days ?? 30, { min: 1, max: 36500 });
  const minConfidence = options.minConfidence ?? 0.65;
  validateConfidence(minConfidence);

  if (!ctx.db) {
    throw new AppError("Database unavailable for report", { code: "DB_NOT_AVAILABLE" });
  }

  const report = reportUpcoming(ctx.db, days, minConfidence);
  const visual = options.visual ? renderUpcomingVisual(report) : null;

  return {
    action: "report.upcoming",
    currency: ctx.config.currency,
    ...report,
    visual,
  };
};
