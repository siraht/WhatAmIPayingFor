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

export const loadConfig = async (paths: RuntimePaths): Promise<FintrackConfig> => {
  await ensureStateDir(paths.stateDir);
  if (!existsSync(paths.configPath)) {
    const initial = createDefaultConfig();
    await saveConfig(paths, initial);
    return initial;
  }

  const raw = await readFile(paths.configPath, "utf8");
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    throw new AppError("Config file is not valid JSON", {
      exitCode: EXIT.RUNTIME,
      code: "CONFIG_PARSE_FAILED",
      details: {
        configPath: paths.configPath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new AppError("Config file must be a JSON object", {
      exitCode: EXIT.RUNTIME,
      code: "CONFIG_INVALID_SHAPE",
      details: { configPath: paths.configPath },
    });
  }
  const parsed = parsedUnknown as Partial<FintrackConfig>;
  return {
    ...createDefaultConfig(),
    ...parsed,
    ynab: parsed.ynab,
    email: parsed.email,
  };
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
