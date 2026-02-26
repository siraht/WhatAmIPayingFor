import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_CURRENCY,
  DEFAULT_PARSER_VERSION,
  DEFAULT_TIMEZONE,
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
  const parsed = JSON.parse(raw) as Partial<FintrackConfig>;
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
  const parsed = JSON.parse(raw) as Partial<RulesFile>;
  return {
    aliases: parsed.aliases ?? {},
    ignore: parsed.ignore ?? [],
    force: parsed.force ?? [],
  };
};
