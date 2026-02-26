#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { APP_NAME, APP_VERSION, EXIT } from "./constants";
import type { GlobalFlags } from "./types";
import { isAppError } from "./errors";
import { closeRuntime, createRuntime } from "./runtime";
import { runSetupEmail, runSetupYnab } from "./commands/setup";
import { runSyncAll, runSyncEmail, runSyncYnab } from "./commands/sync";
import { runReportSpend, runReportSubscriptions, runReportUpcoming } from "./commands/report";
import { runDoctor } from "./doctor";
import { emitJson, printTable } from "./utils/terminal";
import { minorToDisplay } from "./utils/money";

const numberParser = (value: string): number => {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
};

const floatParser = (value: string): number => {
  const trimmed = value.trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
};
const mergeParentOptions = (command: Command, options: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...(command.parent?.opts?.() ?? {}) };
  const getSource =
    typeof (command as unknown as { getOptionValueSource?: (key: string) => string | undefined }).getOptionValueSource ===
    "function"
      ? (command as unknown as { getOptionValueSource: (key: string) => string | undefined }).getOptionValueSource.bind(
          command
        )
      : null;
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) {
      continue;
    }
    const source = getSource ? getSource(key) : undefined;
    if (source === "default" && merged[key] !== undefined) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
};

const getFlags = (command: Command): GlobalFlags => {
  const opts = command.optsWithGlobals();
  return {
    json: Boolean(opts.json),
    noInput: Boolean(opts.noInput),
    config: opts.config,
    stateDir: opts.stateDir,
    verbose: Boolean(opts.verbose),
  };
};

const printSuccess = (payload: any): void => {
  const action = payload?.action as string | undefined;
  if (!action) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (action === "report.spend") {
    const currency = payload.currency || "USD";
    const rows = payload.rows.map((row: any) => [
      row.key,
      minorToDisplay(row.total_minor, currency),
      row.txn_count,
    ]);
    printTable(["Group", "Total", "Transactions"], rows);
    process.stdout.write(`\nMonth: ${payload.month}  Total: ${minorToDisplay(payload.totalMinor, currency)}\n`);
    return;
  }

  if (action === "report.subscriptions") {
    const rows = payload.rows.map((row: any) => [
      row.merchant,
      minorToDisplay(row.typicalAmountMinor, row.currency),
      row.cadence,
      row.lastChargeDate,
      row.nextChargeDate,
      row.confidence.toFixed(2),
      row.isUsageBased ? "yes" : "no",
    ]);
    printTable(
      ["Merchant", "Typical", "Cadence", "Last", "Next", "Confidence", "Usage-Based"],
      rows
    );
    if (payload.rows.some((row: any) => row.reasonCodes && row.reasonCodes.length > 0)) {
      process.stdout.write("\nExplainability:\n");
      for (const row of payload.rows) {
        if (!row.reasonCodes || row.reasonCodes.length === 0) {
          continue;
        }
        process.stdout.write(`- ${row.merchant}: ${row.reasonCodes.join(", ")}\n`);
      }
    }
    return;
  }

  if (action === "report.upcoming") {
    const currency = payload.currency || "USD";
    const rows = payload.rows.map((row: any) => [
      row.date,
      row.merchant,
      minorToDisplay(row.amountMinor, row.currency),
      row.confidence.toFixed(2),
    ]);
    printTable(["Date", "Merchant", "Amount", "Confidence"], rows);
    process.stdout.write("\nDaily Totals:\n");
    for (const daily of payload.totalsByDay) {
      process.stdout.write(`- ${daily.date}: ${minorToDisplay(daily.totalMinor, currency)}\n`);
    }
    process.stdout.write("\nWeekly Totals:\n");
    for (const weekly of payload.totalsByWeek) {
      process.stdout.write(`- ${weekly.weekStart}: ${minorToDisplay(weekly.totalMinor, currency)}\n`);
    }
    if (payload.visual) {
      process.stdout.write(`\n${payload.visual}\n`);
    }
    return;
  }

  if (action === "doctor") {
    for (const check of payload.checks) {
      process.stdout.write(`${check.ok ? "OK" : "WARN"} ${check.id}: ${check.message}\n`);
    }
    process.stdout.write(
      `\nSummary: ${payload.summary.ok} ok, ${payload.summary.failed} failed/warned\n`
    );
    return;
  }

  process.stdout.write(`${action}\n`);
  const rows = Object.entries(payload)
    .filter(([key]) => key !== "action")
    .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]);
  if (rows.length > 0) {
    printTable(["Field", "Value"], rows);
  }
};

const handleError = (error: unknown, asJson: boolean): never => {
  if (isAppError(error)) {
    const payload = {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
    if (asJson) {
      emitJson(payload);
    } else {
      process.stderr.write(`ERROR ${error.code}: ${error.message}\n`);
      if (error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
    }
    process.exit(error.exitCode);
  }

  if (error instanceof CommanderError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(EXIT.INVALID_ARGS);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (asJson) {
    emitJson({ error: { code: "UNHANDLED", message } });
  } else {
    process.stderr.write(`ERROR UNHANDLED: ${message}\n`);
  }
  process.exit(EXIT.RUNTIME);
};

const execute = async (
  command: Command,
  runner: (ctx: Awaited<ReturnType<typeof createRuntime>>, options: any) => Promise<any> | any,
  options: any,
  config?: {
    needsDb?: boolean;
    allowExitCode?: boolean;
    initializeState?: boolean;
    openExistingDbOnly?: boolean;
  }
): Promise<void> => {
  const flags = getFlags(command);
  const ctx = await createRuntime(flags, {
    needsDb: config?.needsDb !== false,
    initializeState: config?.initializeState,
    openExistingDbOnly: config?.openExistingDbOnly,
  });

  try {
    const result = await runner(ctx, options);

    let payload: any = result;
    let exitCode: number = EXIT.SUCCESS;
    if (config?.allowExitCode && result && typeof result === "object" && "exitCode" in result) {
      exitCode = Number(result.exitCode);
      payload = result.data;
    }

    if (flags.json) {
      emitJson(payload);
    } else {
      printSuccess(payload);
    }

    process.exitCode = exitCode;
  } catch (error) {
    handleError(error, flags.json);
  } finally {
    closeRuntime(ctx);
  }
};

const program = new Command();
program
  .name(APP_NAME)
  .description("Track recurring spend using YNAB + Proton Mail Bridge")
  .version(APP_VERSION)
  .option("--json", "machine-readable output")
  .option("--no-input", "disable prompts and confirmations")
  .option("--config <path>", "override config path")
  .option("--state-dir <path>", "override state directory")
  .option("--verbose", "verbose diagnostics");

const setup = program.command("setup").description("configure integrations");
setup
  .command("ynab")
  .description("configure YNAB token env and budget")
  .option("--token-env <name>", "YNAB token environment variable", "YNAB_TOKEN")
  .option("--budget-id <id|last-used|default>", "YNAB budget selector or id", "last-used")
  .option("--dry-run", "validate without persisting")
  .action(async function setupYnabAction(options) {
    await execute(this as Command, runSetupYnab, options, { needsDb: false });
  });

setup
  .command("email")
  .description("configure Proton Bridge IMAP access")
  .option("--imap-host <host>", "IMAP host", "127.0.0.1")
  .option("--imap-port <port>", "IMAP port", numberParser, 1143)
  .requiredOption("--imap-user <value>", "IMAP username")
  .requiredOption("--imap-pass-cmd <command>", "shell command that prints IMAP password")
  .option("--folders <csv>", "folders to sync", "Inbox")
  .option("--probe-bridge", "probe bridge before saving", true)
  .option("--no-probe-bridge", "skip bridge probe")
  .option("--dry-run", "validate without persisting")
  .action(async function setupEmailAction(options) {
    await execute(this as Command, runSetupEmail, options, { needsDb: false });
  });

const sync = program
  .command("sync")
  .description("sync source data and rebuild derived layers")
  .option("--since <YYYY-MM-DD>", "since date for YNAB bootstrap")
  .option("--days <n>", "email backfill days when no cursor", numberParser, 365)
  .option("--deep-parse", "force full body parsing")
  .option("--dry-run", "show what would sync without writing")
  .option("--reset-cursor", "reset sync cursor before syncing")
  .option("--force", "skip reset confirmation")
  .action(async function syncDefaultAction(options) {
    await execute(this as Command, runSyncAll, options, { allowExitCode: true });
  });

sync
  .command("ynab")
  .description("sync YNAB transactions and scheduled transactions")
  .option("--since <YYYY-MM-DD>", "since date for first bootstrap")
  .option("--dry-run", "show what would sync")
  .option("--reset-cursor", "reset sync cursor")
  .option("--force", "skip reset confirmation")
  .action(async function syncYnabAction(options) {
    const command = this as Command;
    await execute(command, runSyncYnab, mergeParentOptions(command, options));
  });

sync
  .command("email")
  .description("sync email evidence from Proton Bridge")
  .option("--days <n>", "backfill days when no cursor", numberParser, 365)
  .option("--deep-parse", "force parse of all candidate messages")
  .option("--dry-run", "show what would sync")
  .option("--reset-cursor", "reset sync cursor")
  .option("--force", "skip reset confirmation")
  .action(async function syncEmailAction(options) {
    const command = this as Command;
    await execute(command, runSyncEmail, mergeParentOptions(command, options));
  });

sync
  .command("all")
  .description("sync YNAB then email then recompute derived insights")
  .option("--since <YYYY-MM-DD>", "since date for YNAB bootstrap")
  .option("--days <n>", "email backfill days when no cursor", numberParser, 365)
  .option("--deep-parse", "force parse of all email candidates")
  .option("--dry-run", "show what would sync")
  .option("--reset-cursor", "reset sync cursor")
  .option("--force", "skip reset confirmation")
  .action(async function syncAllAction(options) {
    const command = this as Command;
    await execute(command, runSyncAll, mergeParentOptions(command, options), { allowExitCode: true });
  });

const report = program.command("report").description("render spend and recurring reports");
report
  .command("spend")
  .description("report spend totals")
  .option("--month <YYYY-MM>", "month to report")
  .option("--group-by <merchant|category|account>", "grouping field", "merchant")
  .action(async function reportSpendAction(options) {
    await execute(this as Command, runReportSpend, options);
  });

report
  .command("subscriptions")
  .description("report detected recurring subscriptions")
  .option("--month <YYYY-MM>", "month to report")
  .option("--min-confidence <0..1>", "confidence threshold", floatParser, 0.65)
  .option("--include-usage-based", "include usage-based recurring merchants")
  .option("--explain", "include reason codes")
  .action(async function reportSubscriptionsAction(options) {
    await execute(this as Command, runReportSubscriptions, options);
  });

report
  .command("upcoming")
  .description("report projected upcoming recurring charges")
  .option("--days <n>", "forecast horizon", numberParser, 30)
  .option("--min-confidence <0..1>", "confidence threshold", floatParser, 0.65)
  .option("--visual", "render ASCII timeline")
  .action(async function reportUpcomingAction(options) {
    await execute(this as Command, runReportUpcoming, options);
  });

program
  .command("doctor")
  .description("diagnose setup and state")
  .action(async function doctorAction() {
    await execute(
      this as Command,
      async (ctx) => {
        const report = runDoctor(ctx.paths, ctx.config, ctx.db);
        return { exitCode: report.exitCode, data: { action: "doctor", ...report } };
      },
      {},
      { allowExitCode: true, needsDb: true, initializeState: false, openExistingDbOnly: true }
    );
  });

program.exitOverride();

(async () => {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      process.exit(EXIT.SUCCESS);
    }
    if (error instanceof CommanderError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT.INVALID_ARGS);
    }
    handleError(error, process.argv.includes("--json"));
  }
})();
