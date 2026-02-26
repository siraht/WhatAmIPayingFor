import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DEFAULT_CONFIG_NAME, DEFAULT_DB_NAME, DEFAULT_RULES_NAME, DEFAULT_STATE_DIR } from "../constants";
import type { RuntimePaths } from "../types";

export const expandHome = (value: string): string => {
  if (!value.startsWith("~")) {
    return value;
  }
  return join(homedir(), value.slice(1));
};

export const buildRuntimePaths = (stateDirFlag?: string, configFlag?: string): RuntimePaths => {
  const stateDir = resolve(expandHome(stateDirFlag || DEFAULT_STATE_DIR));
  const configPath = resolve(expandHome(configFlag || join(stateDir, DEFAULT_CONFIG_NAME)));
  const dbPath = resolve(join(stateDir, DEFAULT_DB_NAME));
  const rulesPath = resolve(join(stateDir, DEFAULT_RULES_NAME));
  return { stateDir, configPath, dbPath, rulesPath };
};

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

export const ensureStateDir = async (stateDir: string): Promise<void> => {
  await mkdir(stateDir, { recursive: true });
};
