import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { AppError } from "./errors";
import {
  DEFAULT_CURRENCY,
  DEFAULT_PARSER_VERSION,
  DEFAULT_TIMEZONE,
  EXIT,
} from "./constants";
import type { FintrackConfig, RuntimePaths } from "./types";
import { ensureParentDir, ensureStateDir } from "./utils/paths";

export interface RulesFile {
  aliases: Record<string, string>;
  ignore: Array<{ merchant: string; reason?: string }>;
  force: Array<{ merchant: string; reason?: string }>;
}

const DEFAULT_RULES: RulesFile = {
  aliases: {},
  ignore: [],
  force: [],
};

export const createDefaultConfig = (): FintrackConfig => ({
  version: 1,
  timezone: DEFAULT_TIMEZONE,
  currency: DEFAULT_CURRENCY,
  parserVersion: DEFAULT_PARSER_VERSION,
});

const normalizeConfig = (parsed: Partial<FintrackConfig>): FintrackConfig => {
  const defaults = createDefaultConfig();

  const currencyRaw =
    typeof parsed.currency === "string" ? parsed.currency.trim().toUpperCase() : defaults.currency;
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : defaults.currency;

  const timezone =
    typeof parsed.timezone === "string" && parsed.timezone.trim().length > 0
      ? parsed.timezone.trim()
      : defaults.timezone;

  const parserVersion =
    typeof parsed.parserVersion === "string" && parsed.parserVersion.trim().length > 0
      ? parsed.parserVersion.trim()
      : defaults.parserVersion;

  const ynab =
    parsed.ynab &&
    typeof parsed.ynab === "object" &&
    typeof parsed.ynab.tokenEnv === "string" &&
    parsed.ynab.tokenEnv.trim().length > 0 &&
    typeof parsed.ynab.budgetId === "string" &&
    parsed.ynab.budgetId.trim().length > 0 &&
    typeof parsed.ynab.budgetSelector === "string" &&
    parsed.ynab.budgetSelector.trim().length > 0
      ? {
          tokenEnv: parsed.ynab.tokenEnv.trim(),
          budgetId: parsed.ynab.budgetId.trim(),
          budgetSelector: parsed.ynab.budgetSelector.trim(),
          lastValidatedAt:
            typeof parsed.ynab.lastValidatedAt === "string" ? parsed.ynab.lastValidatedAt : undefined,
        }
      : undefined;

  const email =
    parsed.email &&
    typeof parsed.email === "object" &&
    typeof parsed.email.imapHost === "string" &&
    parsed.email.imapHost.trim().length > 0 &&
    typeof parsed.email.imapPort === "number" &&
    Number.isInteger(parsed.email.imapPort) &&
    parsed.email.imapPort >= 1 &&
    parsed.email.imapPort <= 65535 &&
    typeof parsed.email.imapUser === "string" &&
    parsed.email.imapUser.trim().length > 0 &&
    typeof parsed.email.imapPassCmd === "string" &&
    parsed.email.imapPassCmd.trim().length > 0 &&
    Array.isArray(parsed.email.folders) &&
    parsed.email.folders.every((folder) => typeof folder === "string" && folder.trim().length > 0)
      ? {
          imapHost: parsed.email.imapHost.trim(),
          imapPort: parsed.email.imapPort,
          imapUser: parsed.email.imapUser.trim(),
          imapPassCmd: parsed.email.imapPassCmd.trim(),
          folders: parsed.email.folders.map((folder) => folder.trim()),
          probeBridge: parsed.email.probeBridge !== false,
          accountLabel:
            typeof parsed.email.accountLabel === "string" && parsed.email.accountLabel.trim().length > 0
              ? parsed.email.accountLabel.trim()
              : parsed.email.imapUser.trim(),
          lastValidatedAt:
            typeof parsed.email.lastValidatedAt === "string" ? parsed.email.lastValidatedAt : undefined,
        }
      : undefined;

  return {
    version: 1,
    timezone,
    currency,
    parserVersion,
    ynab,
    email,
  };
};

const parseConfigRaw = (raw: string, configPath: string): FintrackConfig => {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    throw new AppError("Config file is not valid JSON", {
      exitCode: EXIT.RUNTIME,
      code: "CONFIG_PARSE_FAILED",
      details: {
        configPath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new AppError("Config file must be a JSON object", {
      exitCode: EXIT.RUNTIME,
      code: "CONFIG_INVALID_SHAPE",
      details: { configPath },
    });
  }

  return normalizeConfig(parsedUnknown as Partial<FintrackConfig>);
};

export const loadConfig = async (paths: RuntimePaths): Promise<FintrackConfig> => {
  await ensureStateDir(paths.stateDir);
  if (!existsSync(paths.configPath)) {
    const initial = createDefaultConfig();
    await saveConfig(paths, initial);
    return initial;
  }

  const raw = await readFile(paths.configPath, "utf8");
  return parseConfigRaw(raw, paths.configPath);
};

export const loadConfigReadonly = async (paths: RuntimePaths): Promise<FintrackConfig> => {
  if (!existsSync(paths.configPath)) {
    return createDefaultConfig();
  }
  const raw = await readFile(paths.configPath, "utf8");
  return parseConfigRaw(raw, paths.configPath);
};

export const saveConfig = async (paths: RuntimePaths, config: FintrackConfig): Promise<void> => {
  await ensureParentDir(paths.configPath);
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

export const updateConfig = async (
  paths: RuntimePaths,
  updater: (current: FintrackConfig) => FintrackConfig
): Promise<FintrackConfig> => {
  const current = await loadConfig(paths);
  const next = updater(current);
  await saveConfig(paths, next);
  return next;
};

export const ensureRulesFile = async (paths: RuntimePaths): Promise<void> => {
  await ensureParentDir(paths.rulesPath);
  if (!existsSync(paths.rulesPath)) {
    await writeFile(paths.rulesPath, `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`, "utf8");
  }
};

export const loadRulesFile = async (paths: RuntimePaths): Promise<RulesFile> => {
  await ensureRulesFile(paths);
  const raw = await readFile(paths.rulesPath, "utf8");
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    throw new AppError("Rules file is not valid JSON", {
      exitCode: EXIT.RUNTIME,
      code: "RULES_PARSE_FAILED",
      details: {
        rulesPath: paths.rulesPath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new AppError("Rules file must be a JSON object", {
      exitCode: EXIT.RUNTIME,
      code: "RULES_INVALID_SHAPE",
      details: { rulesPath: paths.rulesPath },
    });
  }
  const parsed = parsedUnknown as Partial<RulesFile>;

  const aliases =
    parsed.aliases && typeof parsed.aliases === "object" && !Array.isArray(parsed.aliases)
      ? Object.fromEntries(
          Object.entries(parsed.aliases).filter(
            ([key, value]) => typeof key === "string" && typeof value === "string"
          )
        )
      : {};

  const normalizeRuleArray = (
    input: unknown
  ): Array<{ merchant: string; reason?: string }> => {
    if (!Array.isArray(input)) {
      return [];
    }
    const out: Array<{ merchant: string; reason?: string }> = [];
    for (const item of input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const merchant = (item as { merchant?: unknown }).merchant;
      const reason = (item as { reason?: unknown }).reason;
      if (typeof merchant !== "string" || merchant.trim().length === 0) {
        continue;
      }
      out.push({
        merchant,
        reason: typeof reason === "string" ? reason : undefined,
      });
    }
    return out;
  };

  return {
    aliases,
    ignore: normalizeRuleArray(parsed.ignore),
    force: normalizeRuleArray(parsed.force),
  };
};
