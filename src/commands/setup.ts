import { AppError } from "../errors";
import { EXIT, EMAIL_DEFAULT_FOLDERS, EMAIL_DEFAULT_HOST, EMAIL_DEFAULT_PORT, YNAB_DEFAULT_TOKEN_ENV } from "../constants";
import type { RuntimeContext } from "../runtime";
import { updateConfig } from "../config";
import { YnabClient, resolveBudgetSelection } from "../ingest/ynab";
import { probeBridge } from "../ingest/email";

export interface SetupYnabOptions {
  tokenEnv?: string;
  budgetId?: string;
  dryRun?: boolean;
}

export const runSetupYnab = async (ctx: RuntimeContext, options: SetupYnabOptions): Promise<unknown> => {
  const tokenEnv = options.tokenEnv || YNAB_DEFAULT_TOKEN_ENV;
  const budgetSelector = options.budgetId || "last-used";
  const token = process.env[tokenEnv];

  let resolvedBudgetId = budgetSelector;
  let budgetName: string | undefined;

  if (budgetSelector === "default" || budgetSelector === "last-used") {
    if (!token) {
      throw new AppError(
        `Cannot resolve --budget-id ${budgetSelector} without token in env ${tokenEnv}`,
        {
          exitCode: EXIT.AUTH_FAILURE,
          code: "YNAB_TOKEN_MISSING",
        }
      );
    }
    const client = new YnabClient(token, ctx.logger);
    const resolved = await resolveBudgetSelection(client, budgetSelector);
    resolvedBudgetId = resolved.id;
    budgetName = resolved.name;
  }

  if (!options.dryRun) {
    await updateConfig(ctx.paths, (current) => ({
      ...current,
      ynab: {
        tokenEnv,
        budgetId: resolvedBudgetId,
        budgetSelector,
        lastValidatedAt: new Date().toISOString(),
      },
    }));
  }

  return {
    action: "setup.ynab",
    dryRun: !!options.dryRun,
    tokenEnv,
    budgetSelector,
    resolvedBudgetId,
    budgetName,
  };
};

export interface SetupEmailOptions {
  imapHost?: string;
  imapPort?: number;
  imapUser: string;
  imapPassCmd: string;
  folders?: string;
  probeBridge?: boolean;
  dryRun?: boolean;
}

export const runSetupEmail = async (ctx: RuntimeContext, options: SetupEmailOptions): Promise<unknown> => {
  const imapHost = options.imapHost || EMAIL_DEFAULT_HOST;
  const imapPort = options.imapPort || EMAIL_DEFAULT_PORT;
  const folders = (options.folders || EMAIL_DEFAULT_FOLDERS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!options.imapUser || !options.imapPassCmd) {
    throw new AppError("setup email requires --imap-user and --imap-pass-cmd", {
      exitCode: EXIT.INVALID_ARGS,
      code: "EMAIL_SETUP_ARGS",
    });
  }

  const shouldProbe = options.probeBridge ?? true;
  let bridgeReachable: boolean | null = null;
  if (shouldProbe) {
    bridgeReachable = await probeBridge(imapHost, imapPort);
    if (!bridgeReachable) {
      ctx.logger.warn("Bridge probe failed; saving configuration anyway", { imapHost, imapPort });
    }
  }

  if (!options.dryRun) {
    await updateConfig(ctx.paths, (current) => ({
      ...current,
      email: {
        imapHost,
        imapPort,
        imapUser: options.imapUser,
        imapPassCmd: options.imapPassCmd,
        folders,
        probeBridge: shouldProbe,
        accountLabel: options.imapUser,
        lastValidatedAt: new Date().toISOString(),
      },
    }));
  }

  return {
    action: "setup.email",
    dryRun: !!options.dryRun,
    imapHost,
    imapPort,
    imapUser: options.imapUser,
    folders,
    probeBridge: shouldProbe,
    bridgeReachable,
  };
};
